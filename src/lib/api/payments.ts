import type { Payment } from '../domain/types'
import * as db from './store'

export function listPayments(): Payment[] {
  return [...db.payments].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getPayment(id: string): Payment | undefined {
  return db.payments.find((p) => p.id === id)
}

export function paymentTotal(p: Payment): number {
  return p.items.reduce((sum, i) => sum + i.price * i.quantity, 0)
}

export function saveDraft(input: Omit<Payment, 'id' | 'status' | 'fixedAt' | 'createdAt' | 'reversalOf'>): Payment {
  const created: Payment = {
    ...input,
    id: db.nextId('p'),
    status: 'draft',
    fixedAt: null,
    createdAt: new Date().toISOString(),
    reversalOf: null,
  }
  db.payments.unshift(created)
  db.notify()
  return created
}

/** 会計確定。確定後の伝票は不変（修正は打消し伝票方式のみ） */
export function fixPayment(id: string) {
  const p = db.payments.find((x) => x.id === id)
  if (!p || p.status !== 'draft') return
  p.status = 'fixed'
  p.fixedAt = new Date().toISOString()
  db.auditLogs.unshift({
    id: db.nextId('a'),
    at: new Date().toISOString(),
    actor: 'デモユーザー',
    action: '会計確定',
    target: `${p.customerName} ¥${paymentTotal(p).toLocaleString()}`,
  })
  db.notify()
}

/** 打消し伝票（マイナス伝票）を発行して会計を取消す (F-04-08) */
export function reversePayment(id: string, reason: string): Payment | undefined {
  const src = db.payments.find((x) => x.id === id)
  if (!src || src.status !== 'fixed') return undefined
  const reversal: Payment = {
    id: db.nextId('p'),
    customerId: src.customerId,
    customerName: src.customerName,
    items: src.items.map((i) => ({ ...i, price: -i.price })),
    tenders: src.tenders.map((t) => ({ ...t, amount: -t.amount })),
    status: 'fixed',
    fixedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    reversalOf: src.id,
  }
  src.status = 'voided'
  db.payments.unshift(reversal)
  db.auditLogs.unshift({
    id: db.nextId('a'),
    at: new Date().toISOString(),
    actor: 'デモユーザー',
    action: '会計取消（打消し伝票）',
    target: `${src.customerName} / 理由: ${reason}`,
  })
  db.notify()
  return reversal
}

/** 本日の現金理論値（レジ締め用） */
export function todayCashTheoretical(): number {
  const today = new Date().toDateString()
  return db.payments
    .filter((p) => p.status === 'fixed' && p.fixedAt && new Date(p.fixedAt).toDateString() === today)
    .flatMap((p) => p.tenders)
    .filter((t) => t.kind === 'cash')
    .reduce((s, t) => s + t.amount, 0)
}

export function closeRegister(counted: number, staffId: string) {
  const dateKey = new Date().toISOString().slice(0, 10)
  db.closings.unshift({
    id: db.nextId('cl'),
    date: dateKey,
    theoreticalCash: todayCashTheoretical(),
    countedCash: counted,
    closedAt: new Date().toISOString(),
    closedBy: staffId,
  })
  db.auditLogs.unshift({
    id: db.nextId('a'),
    at: new Date().toISOString(),
    actor: 'デモユーザー',
    action: 'レジ締め確定',
    target: dateKey,
  })
  db.notify()
}
