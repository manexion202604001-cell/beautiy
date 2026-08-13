import { paymentProvider } from '../payments/provider'
import { isRemoteActive, sync } from './remote'
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
  if (isRemoteActive()) sync.upsertPayment(created)
  db.notify()
  return created
}

/**
 * 会計確定。確定後の伝票は不変（修正は打消し伝票方式のみ）。
 * 各支払は PaymentProvider 経由で処理し、Idempotency Key（伝票ID+支払行）で
 * 二重確定・二重課金を防止する（§41, §79）。
 */
export async function fixPayment(id: string): Promise<void> {
  const p = db.payments.find((x) => x.id === id)
  if (!p || p.status !== 'draft') return
  for (let i = 0; i < p.tenders.length; i++) {
    const tender = p.tenders[i]
    const provider = await paymentProvider.createPayment(
      { amount: tender.amount, method: tender.kind, description: `${p.customerName} / ${tender.label}` },
      `${p.id}:${i}`,
    )
    tender.providerPaymentId = provider.providerPaymentId
  }
  p.status = 'fixed'
  p.fixedAt = new Date().toISOString()
  db.auditLogs.unshift({
    id: db.nextId('a'),
    at: new Date().toISOString(),
    actor: 'デモユーザー',
    action: '会計確定',
    target: `${p.customerName} ¥${paymentTotal(p).toLocaleString()}`,
  })
  if (isRemoteActive()) {
    sync.upsertPayment(p)
    sync.insertAuditLog(db.auditLogs[0])
  }
  db.notify()
}

/** 打消し伝票（マイナス伝票）を発行して会計を取消す (F-04-08)。プロバイダ側も返金する */
export async function reversePayment(id: string, reason: string): Promise<Payment | undefined> {
  const src = db.payments.find((x) => x.id === id)
  if (!src || src.status !== 'fixed') return undefined
  for (const tender of src.tenders) {
    if (tender.providerPaymentId) {
      await paymentProvider.refundPayment(tender.providerPaymentId, tender.amount)
    }
  }
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
  if (isRemoteActive()) {
    sync.upsertPayment(reversal)
    sync.upsertPayment(src)
    sync.insertAuditLog(db.auditLogs[0])
  }
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
  const closing = {
    id: db.nextId('cl'),
    date: dateKey,
    theoreticalCash: todayCashTheoretical(),
    countedCash: counted,
    closedAt: new Date().toISOString(),
    closedBy: staffId,
  }
  db.closings.unshift(closing)
  db.auditLogs.unshift({
    id: db.nextId('a'),
    at: new Date().toISOString(),
    actor: 'デモユーザー',
    action: 'レジ締め確定',
    target: dateKey,
  })
  if (isRemoteActive()) {
    sync.insertClosing(closing)
    sync.insertAuditLog(db.auditLogs[0])
  }
  db.notify()
}
