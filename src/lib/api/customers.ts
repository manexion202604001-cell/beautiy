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

/** 失客リスク: 来店周期 × 1.5 を超過した顧客 (F-05-05) */
export function listChurnRisk(): Customer[] {
  const now = Date.now()
  return db.customers.filter((c) => {
    if (!c.visitCycleDays || !c.lastVisit || c.deletedAt) return false
    const elapsed = (now - new Date(c.lastVisit).getTime()) / 86400000
    return elapsed > c.visitCycleDays * 1.5
  })
}
