/**
 * Supabase リモートデータ層。
 *
 * 方式（v1）: ブートストラップ・キャッシュ + ライトスルー
 * - ログイン後 initRemote() が全業務データを読み込み、既存のインメモリストアへ展開する
 *   （UIは同期のまま動作し、画面側の変更は不要）
 * - 書き込みはローカル反映後に本モジュール経由で Supabase へ非同期反映する
 *   （IDはクライアント生成UUIDで両者一致させる）
 * - 反映失敗は syncErrors に蓄積し、設定画面で可視化する
 * - ダブルブッキングはDB層の EXCLUDE 制約が最終防衛線。挿入が 23P01 で拒否された場合は
 *   ローカルの予約をロールバックする
 */
import { getSupabase, isSupabaseConfigured } from '../supabase/client'
import type {
  AuditLog,
  CashierClosing,
  ChatMessage,
  Customer,
  Karte,
  KarteMemo,
  Menu,
  MessageThread,
  Payment,
  Reservation,
  ReservationHistory,
  ReservationStatus,
  Role,
  Staff,
} from '../domain/types'
import * as db from './store'

interface RemoteContext {
  tenantId: string
  salonId: string
}

let context: RemoteContext | null = null

export function isRemoteActive(): boolean {
  return context !== null
}

export interface SyncError {
  at: string
  operation: string
  message: string
}

export const syncErrors: SyncError[] = []

function recordSyncError(operation: string, error: unknown): void {
  syncErrors.unshift({
    at: new Date().toISOString(),
    operation,
    message: error instanceof Error ? error.message : String(error),
  })
  db.notify()
}

/* ---------------- 行マッパー（snake_case → domain） ---------------- */

type Row = Record<string, unknown>
const s = (v: unknown): string => (v == null ? '' : String(v))
const sn = (v: unknown): string | null => (v == null ? null : String(v))
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0))

function parseRange(range: unknown): { start: string; end: string } {
  // 例: ["2026-08-13 01:00:00+00","2026-08-13 03:00:00+00")
  const m = /[[(]"?([^",]+)"?\s*,\s*"?([^")\]]+)"?[)\]]/.exec(s(range))
  const fix = (t: string) => {
    let iso = t.trim().replace(' ', 'T')
    if (/[+-]\d{2}$/.test(iso)) iso = `${iso}:00`
    return new Date(iso).toISOString()
  }
  if (!m) return { start: new Date().toISOString(), end: new Date().toISOString() }
  return { start: fix(m[1]), end: fix(m[2]) }
}

function toRange(startIso: string, endIso: string): string {
  return `[${startIso},${endIso})`
}

const hhmm = (v: unknown): string => s(v).slice(0, 5)

function mapStaff(r: Row): Staff {
  return {
    id: s(r.id),
    salonId: s(r.salon_id),
    name: s(r.name),
    nameKana: s(r.name_kana),
    role: s(r.role) as Role,
    color: s(r.color) || '#C8A96A',
    active: Boolean(r.active),
  }
}

function mapCustomer(r: Row): Customer {
  return {
    id: s(r.id),
    name: s(r.name),
    nameKana: s(r.name_kana),
    phone: s(r.phone),
    email: s(r.email),
    birthday: sn(r.birthday),
    gender: (sn(r.gender) as Customer['gender']) ?? null,
    lineLinked: r.line_user_id != null,
    ownerType: s(r.owner_type) as Customer['ownerType'],
    ownerStaffId: sn(r.owner_staff_id),
    tags: (r.tags as string[]) ?? [],
    warnings: (r.warnings as string[]) ?? [],
    visitCycleDays: r.visit_cycle_days == null ? null : n(r.visit_cycle_days),
    lastVisit: null, // カルテから再計算
    visitCount: 0,
    totalSpent: 0,
    note: s(r.note),
    channel: s(r.channel),
    deletedAt: sn(r.deleted_at),
  }
}

function mapMenu(r: Row): Menu {
  return {
    id: s(r.id),
    category: s(r.category),
    name: s(r.name),
    durationMin: n(r.duration_min),
    price: n(r.price),
    active: Boolean(r.active),
  }
}

function mapKarte(r: Row): Karte {
  return {
    id: s(r.id),
    customerId: s(r.customer_id),
    staffId: s(r.staff_id),
    date: s(r.visit_date),
    menuNames: (r.menu_names as string[]) ?? [],
    durationMin: n(r.duration_min),
    amount: n(r.amount),
    recipe: (r.recipe as Karte['recipe']) ?? [],
    recipeNote: s(r.recipe_note),
    memo: s(r.memo),
    photoCount: 0,
  }
}

function mapKarteMemo(r: Row): KarteMemo {
  return {
    id: s(r.id),
    customerId: s(r.customer_id),
    staffId: s(r.staff_id),
    date: s(r.created_at).slice(0, 10),
    body: s(r.body),
  }
}

function mapReservation(r: Row): Reservation {
  const { start, end } = parseRange(r.time_range)
  return {
    id: s(r.id),
    customerId: sn(r.customer_id),
    customerName: s(r.customer_name),
    staffId: s(r.staff_id),
    menuIds: (r.menu_ids as string[]) ?? [],
    start,
    end,
    nominated: Boolean(r.nominated),
    status: s(r.status) as ReservationStatus,
    source: s(r.source) as Reservation['source'],
    note: s(r.note),
  }
}

function mapPayment(r: Row): Payment {
  return {
    id: s(r.id),
    customerId: sn(r.customer_id),
    customerName: s(r.customer_name),
    items: (r.items as Payment['items']) ?? [],
    tenders: (r.tenders as Payment['tenders']) ?? [],
    status: s(r.status) as Payment['status'],
    fixedAt: sn(r.fixed_at),
    createdAt: s(r.created_at),
    reversalOf: sn(r.reversal_of),
  }
}

function mapClosing(r: Row): CashierClosing {
  return {
    id: s(r.id),
    date: s(r.closing_date),
    theoreticalCash: n(r.theoretical_cash),
    countedCash: r.counted_cash == null ? null : n(r.counted_cash),
    closedAt: sn(r.closed_at),
    closedBy: sn(r.closed_by),
  }
}

function mapThread(r: Row): MessageThread {
  return {
    id: s(r.id),
    customerId: s(r.customer_id),
    channel: s(r.channel) as MessageThread['channel'],
    lastMessageAt: s(r.last_message_at),
    unread: n(r.unread),
  }
}

function mapMessage(r: Row): ChatMessage {
  return {
    id: s(r.id),
    threadId: s(r.thread_id),
    from: s(r.sender) as ChatMessage['from'],
    body: s(r.body),
    at: s(r.sent_at),
    read: Boolean(r.read),
  }
}

function mapHistory(r: Row): ReservationHistory {
  return {
    id: s(r.id),
    reservationId: s(r.reservation_id),
    before: s(r.before_status) as ReservationStatus,
    after: s(r.after_status) as ReservationStatus,
    changedBy: staffNameById(sn(r.changed_by)) ?? 'スタッフ',
    changedAt: s(r.changed_at),
    reason: (sn(r.reason) as ReservationHistory['reason']) ?? null,
  }
}

function mapAuditLog(r: Row): AuditLog {
  const detail = (r.detail ?? {}) as { actor?: string; target?: string }
  return {
    id: s(r.id),
    at: s(r.created_at),
    actor: detail.actor ?? staffNameById(sn(r.actor_staff_id)) ?? 'スタッフ',
    action: s(r.action),
    target: detail.target ?? s(r.target_id),
  }
}

function staffNameById(id: string | null): string | null {
  if (!id) return null
  return db.staffList.find((st) => st.id === id)?.name ?? null
}

function staffIdByName(name: string): string | null {
  return db.staffList.find((st) => st.name === name)?.id ?? null
}

/* ---------------- ブートストラップ（読み込み） ---------------- */

function replaceAll<T>(target: T[], rows: T[]): void {
  target.length = 0
  target.push(...rows)
}

/** 顧客の来店集計をカルテ・会計から再計算（DBは集計列を持たない） */
function recomputeCustomerAggregates(): void {
  for (const c of db.customers) {
    const kartes = db.kartes.filter((k) => k.customerId === c.id).sort((a, b) => a.date.localeCompare(b.date))
    c.visitCount = kartes.length
    c.lastVisit = kartes.length > 0 ? kartes[kartes.length - 1].date : null
    c.totalSpent = db.payments
      .filter((p) => p.customerId === c.id && p.status !== 'draft')
      .reduce((sum, p) => sum + p.items.reduce((si, i) => si + i.price * i.quantity, 0), 0)
  }
}

/**
 * サインイン済みユーザーのテナント全データを読み込みストアへ展開する。
 * 戻り値はサインインスタッフの行（セッション確立に使う）。
 */
export async function initRemote(): Promise<Staff | null> {
  if (!isSupabaseConfigured) return null
  const supabase = getSupabase()

  const { data: authData } = await supabase.auth.getUser()
  const authUserId = authData.user?.id
  if (!authUserId) return null

  db.setRemoteMode(true)

  const { data: me, error: meError } = await supabase
    .from('staff')
    .select('*')
    .eq('auth_user_id', authUserId)
    .single()
  if (meError || !me) {
    throw new Error(
      'スタッフ登録が見つかりません。staff テーブルに auth_user_id を紐付けてください（docs/golive.md 手順4）。',
    )
  }

  const [salons, staff, customers, menus, kartes, memos, reservations, histories, payments, closings, threads, messages, audits] =
    await Promise.all([
      supabase.from('salons').select('*').limit(1),
      supabase.from('staff').select('*').order('created_at'),
      supabase.from('customers').select('*').is('deleted_at', null),
      supabase.from('menus').select('*').eq('active', true).order('created_at'),
      supabase.from('kartes').select('*').order('visit_date', { ascending: false }),
      supabase.from('karte_memos').select('*').order('created_at', { ascending: false }),
      supabase.from('reservations').select('*'),
      supabase.from('reservation_history').select('*').order('changed_at', { ascending: false }),
      supabase.from('payments').select('*').order('created_at', { ascending: false }),
      supabase.from('cashier_closings').select('*').order('closing_date', { ascending: false }),
      supabase.from('message_threads').select('*'),
      supabase.from('messages').select('*').order('sent_at'),
      supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(100),
    ])

  const firstError = [salons, staff, customers, menus, kartes, memos, reservations, histories, payments, closings, threads, messages, audits]
    .map((r) => r.error)
    .find(Boolean)
  if (firstError) throw new Error(`データ読み込みに失敗しました: ${firstError.message}`)

  const salonRow = (salons.data ?? [])[0] as Row | undefined
  if (!salonRow) throw new Error('店舗データがありません。supabase/seed.sql を実行してください。')

  context = { tenantId: s(salonRow.tenant_id), salonId: s(salonRow.id) }

  Object.assign(db.salon, {
    id: s(salonRow.id),
    name: s(salonRow.name),
    openTime: hhmm(salonRow.open_time) || '10:00',
    closeTime: hhmm(salonRow.close_time) || '20:00',
    invoiceNumber: s(salonRow.invoice_number),
    closedWeekdays: (salonRow.closed_weekdays as number[]) ?? [],
  })

  replaceAll(db.staffList, ((staff.data ?? []) as Row[]).map(mapStaff))
  replaceAll(db.customers, ((customers.data ?? []) as Row[]).map(mapCustomer))
  replaceAll(db.menus, ((menus.data ?? []) as Row[]).map(mapMenu))
  replaceAll(db.kartes, ((kartes.data ?? []) as Row[]).map(mapKarte))
  replaceAll(db.karteMemos, ((memos.data ?? []) as Row[]).map(mapKarteMemo))
  replaceAll(db.reservations, ((reservations.data ?? []) as Row[]).map(mapReservation))
  replaceAll(db.reservationHistories, ((histories.data ?? []) as Row[]).map(mapHistory))
  replaceAll(db.payments, ((payments.data ?? []) as Row[]).map(mapPayment))
  replaceAll(db.closings, ((closings.data ?? []) as Row[]).map(mapClosing))
  replaceAll(db.threads, ((threads.data ?? []) as Row[]).map(mapThread))
  replaceAll(db.messages, ((messages.data ?? []) as Row[]).map(mapMessage))
  replaceAll(db.auditLogs, ((audits.data ?? []) as Row[]).map(mapAuditLog))
  recomputeCustomerAggregates()
  db.notify()

  return mapStaff(me as Row)
}

/* ---------------- ライトスルー（書き込み） ----------------
 * ローカル反映済みのエンティティをDBへ非同期反映する。失敗は syncErrors へ。
 */

function fire(operation: string, run: () => PromiseLike<{ error: { message: string; code?: string } | null }>): void {
  if (!context) return
  void (async () => {
    try {
      const { error } = await run()
      if (error) throw new Error(`${error.code ?? ''} ${error.message}`)
    } catch (e) {
      recordSyncError(operation, e)
    }
  })()
}

export const sync = {
  upsertCustomer(c: Customer): void {
    fire('customer.upsert', () =>
      getSupabase().from('customers').upsert({
        id: c.id,
        tenant_id: context!.tenantId,
        salon_id: context!.salonId,
        owner_type: c.ownerType,
        owner_staff_id: c.ownerStaffId,
        name: c.name,
        name_kana: c.nameKana,
        phone: c.phone,
        email: c.email,
        birthday: c.birthday,
        gender: c.gender,
        tags: c.tags,
        warnings: c.warnings,
        visit_cycle_days: c.visitCycleDays,
        note: c.note,
        channel: c.channel,
        deleted_at: c.deletedAt,
      }),
    )
  },

  insertKarte(k: Karte): void {
    fire('karte.insert', () =>
      getSupabase().from('kartes').insert({
        id: k.id,
        tenant_id: context!.tenantId,
        salon_id: context!.salonId,
        customer_id: k.customerId,
        staff_id: k.staffId,
        visit_date: k.date,
        menu_names: k.menuNames,
        duration_min: k.durationMin,
        amount: k.amount,
        recipe: k.recipe,
        recipe_note: k.recipeNote,
        memo: k.memo,
      }),
    )
  },

  insertKarteMemo(m: KarteMemo): void {
    fire('karte_memo.insert', () =>
      getSupabase().from('karte_memos').insert({
        id: m.id,
        tenant_id: context!.tenantId,
        customer_id: m.customerId,
        staff_id: m.staffId,
        body: m.body,
      }),
    )
  },

  /** 予約挿入。DBの排他制約(23P01)で拒否された場合 onConflict を呼び出す */
  insertReservation(r: Reservation, onConflict: () => void): void {
    if (!context) return
    void (async () => {
      try {
        const { error } = await getSupabase().from('reservations').insert({
          id: r.id,
          tenant_id: context!.tenantId,
          salon_id: context!.salonId,
          customer_id: r.customerId,
          customer_name: r.customerName,
          staff_id: r.staffId,
          menu_ids: r.menuIds,
          time_range: toRange(r.start, r.end),
          nominated: r.nominated,
          status: r.status,
          source: r.source,
          note: r.note,
        })
        if (error) {
          if (error.code === '23P01') {
            onConflict()
            return
          }
          throw new Error(`${error.code} ${error.message}`)
        }
      } catch (e) {
        recordSyncError('reservation.insert', e)
      }
    })()
  },

  updateReservationStatus(r: Reservation, reason: string | null): void {
    fire('reservation.status', () =>
      getSupabase()
        .from('reservations')
        .update({ status: r.status, cancellation_reason: reason })
        .eq('id', r.id),
    )
  },

  upsertPayment(p: Payment): void {
    fire('payment.upsert', () =>
      getSupabase().from('payments').upsert({
        id: p.id,
        tenant_id: context!.tenantId,
        salon_id: context!.salonId,
        customer_id: p.customerId,
        customer_name: p.customerName,
        items: p.items,
        tenders: p.tenders,
        status: p.status,
        fixed_at: p.fixedAt,
        reversal_of: p.reversalOf,
      }),
    )
  },

  insertClosing(c: CashierClosing): void {
    fire('closing.insert', () =>
      getSupabase().from('cashier_closings').insert({
        id: c.id,
        tenant_id: context!.tenantId,
        salon_id: context!.salonId,
        closing_date: c.date,
        theoretical_cash: c.theoreticalCash,
        counted_cash: c.countedCash ?? 0,
        closed_by: c.closedBy,
        closed_at: c.closedAt,
      }),
    )
  },

  insertMessage(m: ChatMessage, thread: MessageThread): void {
    fire('message.insert', () =>
      getSupabase().from('messages').insert({
        id: m.id,
        tenant_id: context!.tenantId,
        thread_id: m.threadId,
        sender: m.from,
        body: m.body,
        read: m.read,
      }),
    )
    fire('thread.update', () =>
      getSupabase()
        .from('message_threads')
        .update({ last_message_at: thread.lastMessageAt, unread: thread.unread })
        .eq('id', thread.id),
    )
  },

  markThreadRead(threadId: string, thread: MessageThread): void {
    fire('thread.read', () =>
      getSupabase().from('messages').update({ read: true }).eq('thread_id', threadId),
    )
    fire('thread.update', () =>
      getSupabase().from('message_threads').update({ unread: thread.unread }).eq('id', thread.id),
    )
  },

  insertAuditLog(a: AuditLog): void {
    fire('audit.insert', () =>
      getSupabase().from('audit_logs').insert({
        id: a.id,
        tenant_id: context!.tenantId,
        actor_staff_id: staffIdByName(a.actor),
        action: a.action,
        target_type: 'app',
        target_id: null,
        detail: { actor: a.actor, target: a.target },
      }),
    )
  },
}
