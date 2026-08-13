/**
 * Customer Timeline（マスター要件定義書 §87-88）
 * 予約・カルテ・会計・メッセージを customer を中心に統一時系列で提供する。
 * LTV KPI（§32）と次回来店予測（§20）もここで算出する。
 */
import { addDays, differenceInCalendarDays, format } from 'date-fns'
import { paymentTotal } from './payments'
import * as db from './store'

export type TimelineEventType = 'reservation' | 'karte' | 'payment' | 'message'

export interface TimelineEvent {
  at: string // ISO
  type: TimelineEventType
  title: string
  detail: string
  amount: number | null
}

export function buildTimeline(customerId: string): TimelineEvent[] {
  const events: TimelineEvent[] = []

  for (const r of db.reservations) {
    if (r.customerId !== customerId) continue
    const menuNames = r.menuIds
      .map((id) => db.menus.find((m) => m.id === id)?.name)
      .filter(Boolean)
      .join('・')
    const statusLabel = {
      confirmed: '確定',
      tentative: '仮予約',
      done: '来店済',
      cancelled: 'キャンセル',
      no_show: '無断キャンセル',
    }[r.status]
    events.push({
      at: r.start,
      type: 'reservation',
      title: `予約（${statusLabel}）`,
      detail: menuNames || r.note,
      amount: null,
    })
  }

  for (const k of db.kartes) {
    if (k.customerId !== customerId) continue
    events.push({
      at: `${k.date}T12:00:00`,
      type: 'karte',
      title: 'カルテ',
      detail: k.menuNames.join('・'),
      amount: k.amount,
    })
  }

  for (const p of db.payments) {
    if (p.customerId !== customerId || p.status === 'draft') continue
    events.push({
      at: p.fixedAt ?? p.createdAt,
      type: 'payment',
      title: p.reversalOf ? '会計（打消し伝票）' : '会計',
      detail: p.items.map((i) => i.name).join('、'),
      amount: paymentTotal(p),
    })
  }

  const threadIds = db.threads.filter((t) => t.customerId === customerId).map((t) => t.id)
  for (const m of db.messages) {
    if (!threadIds.includes(m.threadId)) continue
    const from = { salon: 'サロン', customer: 'お客様', auto: '自動送信' }[m.from]
    events.push({
      at: m.at,
      type: 'message',
      title: `メッセージ（${from}）`,
      detail: m.body.length > 60 ? `${m.body.slice(0, 60)}…` : m.body,
      amount: null,
    })
  }

  return events.sort((a, b) => b.at.localeCompare(a.at))
}

export interface LtvStats {
  /** 累計純売上（打消し伝票を含む合計） */
  totalNetSales: number
  /** 平均客単価 */
  averageSpend: number
  visitCount: number
  /** 実績ベースの平均来店周期（日）。実績2回未満なら設定値にフォールバック */
  averageIntervalDays: number | null
  /** 次回来店予測日 yyyy-MM-dd（§20: 前回来店日 + 平均周期） */
  nextVisitPrediction: string | null
}

export function ltvStats(customerId: string): LtvStats {
  const customer = db.customers.find((c) => c.id === customerId)

  // 純売上は会計台帳（打消し伝票込み）から算出。会計記録がない旧来分は顧客集計値を使う
  const paymentsNet = db.payments
    .filter((p) => p.customerId === customerId && p.status !== 'draft')
    .reduce((s, p) => s + paymentTotal(p), 0)
  const totalNetSales = Math.max(paymentsNet, customer?.totalSpent ?? 0)

  const visitDates = db.kartes
    .filter((k) => k.customerId === customerId)
    .map((k) => k.date)
    .sort()
  const visitCount = Math.max(visitDates.length, customer?.visitCount ?? 0)
  const averageSpend = visitCount > 0 ? Math.round(totalNetSales / visitCount) : 0

  let averageIntervalDays: number | null = null
  if (visitDates.length >= 2) {
    const gaps: number[] = []
    for (let i = 1; i < visitDates.length; i++) {
      gaps.push(differenceInCalendarDays(new Date(visitDates[i]), new Date(visitDates[i - 1])))
    }
    averageIntervalDays = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length)
  } else if (customer?.visitCycleDays) {
    averageIntervalDays = customer.visitCycleDays
  }

  let nextVisitPrediction: string | null = null
  const lastVisit = visitDates[visitDates.length - 1] ?? customer?.lastVisit ?? null
  if (lastVisit && averageIntervalDays) {
    nextVisitPrediction = format(addDays(new Date(lastVisit), averageIntervalDays), 'yyyy-MM-dd')
  }

  return { totalNetSales, averageSpend, visitCount, averageIntervalDays, nextVisitPrediction }
}
