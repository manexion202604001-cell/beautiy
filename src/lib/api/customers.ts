import type { Customer, Karte, KarteMemo } from '../domain/types'
import * as db from './store'

export interface CustomerFilter {
  query?: string
  tag?: string
  staffId?: string
}

/** F-01-09 顧客検索（氏名/カナ/電話 部分一致 + タグ + 担当） */
export function searchCustomers(filter: CustomerFilter): Customer[] {
  const q = (filter.query ?? '').trim().toLowerCase()
  return db.customers
    .filter((c) => c.deletedAt === null)
    .filter((c) => {
      if (q) {
        const hit =
          c.name.toLowerCase().includes(q) ||
          c.nameKana.toLowerCase().includes(q) ||
          c.phone.replace(/-/g, '').includes(q.replace(/-/g, ''))
        if (!hit) return false
      }
      if (filter.tag && !c.tags.includes(filter.tag)) return false
      if (filter.staffId && c.ownerStaffId !== filter.staffId) return false
      return true
    })
}

export function getCustomer(id: string): Customer | undefined {
  return db.customers.find((c) => c.id === id && c.deletedAt === null)
}

export function listAllTags(): string[] {
  return [...new Set(db.customers.flatMap((c) => c.tags))]
}

export function listKartes(customerId: string): Karte[] {
  return db.kartes
    .filter((k) => k.customerId === customerId)
    .sort((a, b) => b.date.localeCompare(a.date))
}

export function getKarte(id: string): Karte | undefined {
  return db.kartes.find((k) => k.id === id)
}

export function listKarteMemos(customerId: string): KarteMemo[] {
  return db.karteMemos.filter((m) => m.customerId === customerId)
}

export function addKarte(karte: Omit<Karte, 'id'>): Karte {
  const created: Karte = { ...karte, id: db.nextId('k') }
  db.kartes.unshift(created)
  const customer = db.customers.find((c) => c.id === karte.customerId)
  if (customer) {
    customer.lastVisit = karte.date
    customer.visitCount += 1
    customer.totalSpent += karte.amount
  }
  db.auditLogs.unshift({
    id: db.nextId('a'),
    at: new Date().toISOString(),
    actor: 'デモユーザー',
    action: 'カルテ作成',
    target: customer?.name ?? karte.customerId,
  })
  db.notify()
  return created
}

export function addMemo(customerId: string, staffId: string, body: string) {
  db.karteMemos.unshift({
    id: db.nextId('km'),
    customerId,
    staffId,
    date: new Date().toISOString().slice(0, 10),
    body,
  })
  db.notify()
}

export type CustomerInput = Omit<
  Customer,
  'id' | 'lastVisit' | 'visitCount' | 'totalSpent' | 'deletedAt'
>

export function createCustomer(input: CustomerInput): Customer {
  const created: Customer = {
    ...input,
    id: db.nextId('c'),
    lastVisit: null,
    visitCount: 0,
    totalSpent: 0,
    deletedAt: null,
  }
  db.customers.unshift(created)
  db.auditLogs.unshift({
    id: db.nextId('a'),
    at: new Date().toISOString(),
    actor: 'デモユーザー',
    action: '顧客登録',
    target: created.name,
  })
  db.notify()
  return created
}

export function updateCustomer(id: string, patch: Partial<CustomerInput>): Customer | undefined {
  const customer = db.customers.find((c) => c.id === id && c.deletedAt === null)
  if (!customer) return undefined
  Object.assign(customer, patch)
  db.auditLogs.unshift({
    id: db.nextId('a'),
    at: new Date().toISOString(),
    actor: 'デモユーザー',
    action: '顧客情報編集',
    target: customer.name,
  })
  db.notify()
  return customer
}

/** 論理削除。カルテ・会計は保持（本番では30日後に匿名化・物理削除） */
export function deleteCustomer(id: string): void {
  const customer = db.customers.find((c) => c.id === id)
  if (!customer) return
  customer.deletedAt = new Date().toISOString()
  db.auditLogs.unshift({
    id: db.nextId('a'),
    at: new Date().toISOString(),
    actor: 'デモユーザー',
    action: '顧客削除（論理削除）',
    target: customer.name,
  })
  db.notify()
}

/** F-01-12 顧客CSVエクスポート（監査ログ記録・Excel対応BOM付きで出力する想定） */
export function exportCustomersCsv(): string {
  const header = [
    '氏名', 'フリガナ', '電話', 'メール', '生年月日', '性別', '来店経路',
    'タグ', '警告', '来店周期(日)', '最終来店', '来店回数', '累計利用額', 'メモ',
  ]
  const esc = (v: string | number | null) => {
    const s = v === null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = db.customers
    .filter((c) => c.deletedAt === null)
    .map((c) =>
      [
        c.name, c.nameKana, c.phone, c.email, c.birthday ?? '', c.gender ?? '', c.channel,
        c.tags.join('・'), c.warnings.join('・'), c.visitCycleDays ?? '', c.lastVisit ?? '',
        c.visitCount, c.totalSpent, c.note,
      ].map(esc).join(','),
    )
  db.auditLogs.unshift({
    id: db.nextId('a'),
    at: new Date().toISOString(),
    actor: 'デモユーザー',
    action: '顧客CSVエクスポート',
    target: `${rows.length}件`,
  })
  db.notify()
  return [header.join(','), ...rows].join('\r\n')
}

/** 失客リスク: 来店周期 × 1.5 を超過した顧客 (F-05-05) */
export function listChurnRisk(): Customer[] {
  const now = Date.now()
  return db.customers.filter((c) => {
    if (!c.visitCycleDays || !c.lastVisit || c.deletedAt) return false
    const elapsed = (now - new Date(c.lastVisit).getTime()) / 86400000
    return elapsed > c.visitCycleDays * 1.5
  })
}
