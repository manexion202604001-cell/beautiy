import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { auditUserId, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { emit } from '../../lib/events.js';
import { activeProvider, providerByName } from './providers/index.js';

/**
 * PUBLIC CONTRACT of the payments module (FR-05). Other modules (POS, commerce) start online
 * payments and refunds ONLY through these functions. Results arrive asynchronously:
 *   domain events 'payment.succeeded' | 'payment.failed' | 'payment.refunded'
 *   payload: { paymentId, transactionId: string|null, orderId: string|null, amount, refundedAmount? }
 * Guarantees: one payment row per (organization, idempotencyKey); provider payment id unique;
 * a payment is linked to exactly one transaction OR order; the amount never exceeds the
 * outstanding balance of that transaction/order (double-charge prevention).
 */
export interface StartOnlinePaymentInput {
  transactionId?: string;
  orderId?: string;
  amount: number;
  idempotencyKey: string;
  description?: string;
  customerId?: string | null;
  metadata?: Record<string, string>;
}

export interface OnlinePaymentResult {
  paymentId: string;
  status: string;
  provider: string;
  providerPaymentId: string | null;
  /** client secret / redirect for the payer UI (Stripe Elements, hosted page) */
  clientSecret: string | null;
  replayed: boolean;
}

/** statuses that hold (part of) the balance */
export const ACTIVE_PAYMENT_STATUSES = ['pending', 'requires_action', 'succeeded', 'partially_refunded', 'refunded'] as const;
export const FINAL_PAYMENT_STATUSES = ['succeeded', 'failed', 'cancelled', 'refunded', 'partially_refunded'];
export const OFFLINE_METHODS = ['cash', 'card', 'emoney', 'qr', 'custom', 'point'] as const;
export type OfflineMethod = (typeof OFFLINE_METHODS)[number];

async function lockKey(ctx: Ctx, key: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pay:${ctx.actor.organizationId}:${key}`}, 0))`.execute(ctx.trx);
}

export interface BalanceTarget {
  transactionId?: string | null;
  orderId?: string | null;
}

/**
 * Outstanding balance of a transaction/order = total − Σ(active payments net of refunds).
 * Locks the target row (FOR UPDATE) so concurrent payment starts serialize.
 */
export async function outstandingBalance(ctx: Ctx, target: BalanceTarget): Promise<{ total: number; held: number; succeeded: number; outstanding: number; status: string }> {
  let total: number;
  let status: string;
  if (target.transactionId) {
    const tx = await ctx.trx.selectFrom('transactions').select(['total', 'status']).where('id', '=', target.transactionId).forUpdate().executeTakeFirst();
    if (!tx) throw Errors.notFound('会計', target.transactionId);
    total = tx.total;
    status = tx.status;
  } else if (target.orderId) {
    const o = await ctx.trx.selectFrom('orders').select(['total', 'status']).where('id', '=', target.orderId).forUpdate().executeTakeFirst();
    if (!o) throw Errors.notFound('注文', target.orderId);
    total = o.total;
    status = o.status;
  } else throw Errors.validation('transactionIdかorderIdのどちらか一方を指定してください');
  const rows = await ctx.trx
    .selectFrom('payments')
    .select(['amount', 'refunded_amount', 'status'])
    .$if(!!target.transactionId, (q) => q.where('transaction_id', '=', target.transactionId!))
    .$if(!target.transactionId, (q) => q.where('order_id', '=', target.orderId!))
    .where('status', 'in', [...ACTIVE_PAYMENT_STATUSES])
    .execute();
  const held = rows.reduce((s, r) => s + r.amount - r.refunded_amount, 0);
  const succeeded = rows.filter((r) => ['succeeded', 'partially_refunded', 'refunded'].includes(r.status)).reduce((s, r) => s + r.amount - r.refunded_amount, 0);
  return { total, held, succeeded, outstanding: total - held, status };
}

function replayCheck(existing: { amount: number; transaction_id: string | null; order_id: string | null }, input: { amount: number; transactionId?: string | null; orderId?: string | null }) {
  if (existing.amount !== input.amount || existing.transaction_id !== (input.transactionId ?? null) || existing.order_id !== (input.orderId ?? null)) {
    throw Errors.business('IDEMPOTENCY_KEY_REUSED', '同じIdempotency-Keyが異なる決済で使用されています');
  }
}

export async function startOnlinePayment(ctx: Ctx, input: StartOnlinePaymentInput): Promise<OnlinePaymentResult> {
  if ((input.transactionId ? 1 : 0) + (input.orderId ? 1 : 0) !== 1) throw Errors.validation('transactionIdかorderIdのどちらか一方を指定してください');
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw Errors.validation('金額が不正です');
  if (!input.idempotencyKey || input.idempotencyKey.length > 255) throw Errors.validation('idempotencyKeyが不正です');
  await lockKey(ctx, input.idempotencyKey);
  const existing = await ctx.trx.selectFrom('payments').selectAll().where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
  if (existing) {
    replayCheck(existing, input);
    return {
      paymentId: existing.id,
      status: existing.status,
      provider: existing.provider ?? 'mock',
      providerPaymentId: existing.provider_payment_id,
      clientSecret: existing.client_secret,
      replayed: true,
    };
  }

  const balance = await outstandingBalance(ctx, input);
  if (input.transactionId && balance.status !== 'draft') throw Errors.business('TRANSACTION_NOT_DRAFT', '確定済みまたは取消済みの会計には決済できません');
  if (input.orderId && balance.status !== 'pending') throw Errors.business('ORDER_NOT_PAYABLE', 'この注文は決済できる状態ではありません');
  if (input.amount > balance.outstanding) {
    throw Errors.business('AMOUNT_EXCEEDS_BALANCE', '決済金額が未払い残高を超えています', { outstanding: balance.outstanding });
  }

  const provider = activeProvider();
  const paymentId = randomUUID();
  const metadata: Record<string, string> = {
    ...(input.metadata ?? {}),
    organization_id: ctx.actor.organizationId,
    payment_id: paymentId,
    ...(input.transactionId ? { transaction_id: input.transactionId } : {}),
    ...(input.orderId ? { order_id: input.orderId } : {}),
  };
  // provider idempotency key is tenant-scoped: one provider account may serve many organizations
  const created = await provider.createPayment({
    amount: input.amount,
    currency: 'jpy',
    idempotencyKey: `${ctx.actor.organizationId}:${input.idempotencyKey}`,
    description: input.description,
    metadata,
  });
  const row = await ctx.trx
    .insertInto('payments')
    .values({
      id: paymentId,
      organization_id: ctx.actor.organizationId,
      transaction_id: input.transactionId ?? null,
      order_id: input.orderId ?? null,
      method: 'online',
      provider: provider.name,
      provider_payment_id: created.providerPaymentId,
      amount: input.amount,
      status: created.status === 'succeeded' ? 'pending' : created.status === 'cancelled' ? 'cancelled' : created.status,
      idempotency_key: input.idempotencyKey,
      client_secret: created.clientSecret,
      metadata: JSON.stringify({ ...metadata, ...(input.customerId ? { customer_id: input.customerId } : {}) }),
      created_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .returning(['id', 'status', 'provider', 'provider_payment_id', 'client_secret'])
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'payment.start', resourceType: 'payment', resourceId: row.id, after: { amount: input.amount, provider: provider.name, transactionId: input.transactionId ?? null, orderId: input.orderId ?? null } });
  let status = row.status;
  if (created.status === 'succeeded') status = (await settleOnlinePayment(ctx, row.id, { success: true })).status;
  return { paymentId: row.id, status, provider: row.provider!, providerPaymentId: row.provider_payment_id, clientSecret: row.client_secret, replayed: false };
}

/**
 * Mark a pending online payment as succeeded/failed (used by provider webhooks and by the mock
 * provider in dev/test). Idempotent: repeated calls for a final state are no-ops.
 */
export async function settleOnlinePayment(ctx: Ctx, paymentId: string, outcome: { success: boolean; failureCode?: string; failureReason?: string }) {
  const p = await ctx.trx.selectFrom('payments').selectAll().where('id', '=', paymentId).forUpdate().executeTakeFirst();
  if (!p) throw Errors.notFound('決済', paymentId);
  if (FINAL_PAYMENT_STATUSES.includes(p.status)) return p;
  const status = outcome.success ? 'succeeded' : 'failed';
  const updated = await ctx.trx
    .updateTable('payments')
    .set({ status, succeeded_at: outcome.success ? new Date() : null, failure_code: outcome.failureCode ?? null, failure_reason: outcome.failureReason ?? null })
    .where('id', '=', paymentId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: `payment.${status}`, resourceType: 'payment', resourceId: paymentId, before: { status: p.status }, after: { status, failureCode: outcome.failureCode ?? null } });
  await emit(ctx, {
    type: outcome.success ? 'payment.succeeded' : 'payment.failed',
    aggregateType: 'payment',
    aggregateId: paymentId,
    payload: { paymentId, transactionId: p.transaction_id, orderId: p.order_id, amount: p.amount },
  });
  return updated;
}

export interface RefundInput {
  paymentId: string;
  amount: number;
  reason?: string;
  idempotencyKey: string;
  /** cash refunds: the open register session the cash leaves from (レジ締め計算用) */
  registerSessionId?: string | null;
}

export async function refundPayment(ctx: Ctx, input: RefundInput) {
  const p = await ctx.trx.selectFrom('payments').selectAll().where('id', '=', input.paymentId).forUpdate().executeTakeFirst();
  if (!p) throw Errors.notFound('決済', input.paymentId);
  const existing = await ctx.trx.selectFrom('refunds').selectAll().where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
  if (existing) {
    if (existing.payment_id !== p.id || existing.amount !== input.amount) {
      throw Errors.business('IDEMPOTENCY_KEY_REUSED', '同じIdempotency-Keyが異なる返金で使用されています');
    }
    return existing;
  }
  if (!['succeeded', 'partially_refunded'].includes(p.status)) throw Errors.business('PAYMENT_NOT_REFUNDABLE', 'この決済は返金できません');
  if (!Number.isInteger(input.amount) || input.amount <= 0 || p.refunded_amount + input.amount > p.amount) {
    throw Errors.business('REFUND_EXCEEDS_PAYMENT', '返金額が決済額を超えています', { refundable: p.amount - p.refunded_amount });
  }

  let providerRefundId: string | null = null;
  let status: 'pending' | 'succeeded' | 'failed' = 'succeeded';
  if (p.method === 'online' && p.provider && p.provider_payment_id) {
    const res = await providerByName(p.provider).refund({
      providerPaymentId: p.provider_payment_id,
      amount: input.amount,
      idempotencyKey: `${ctx.actor.organizationId}:refund:${input.idempotencyKey}`,
      reason: input.reason,
      metadata: { organization_id: ctx.actor.organizationId, payment_id: p.id },
    });
    providerRefundId = res.providerRefundId;
    status = res.status;
    if (status === 'failed') throw Errors.external(p.provider, '決済サービスで返金が拒否されました');
  }
  const refund = await ctx.trx
    .insertInto('refunds')
    .values({
      organization_id: ctx.actor.organizationId,
      payment_id: p.id,
      amount: input.amount,
      reason: input.reason ?? null,
      status,
      idempotency_key: input.idempotencyKey,
      provider_refund_id: providerRefundId,
      register_session_id: input.registerSessionId ?? null,
      created_by: auditUserId(ctx.actor),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  // pending refunds already reserve the amount so a second refund can never exceed the payment
  const refunded = p.refunded_amount + input.amount;
  await ctx.trx
    .updateTable('payments')
    .set({ refunded_amount: refunded, status: refunded >= p.amount ? 'refunded' : 'partially_refunded' })
    .where('id', '=', p.id)
    .execute();
  await audit(ctx, { action: 'payment.refund', resourceType: 'payment', resourceId: p.id, after: { refundId: refund.id, amount: input.amount, reason: input.reason ?? null, status } });
  await emit(ctx, {
    type: 'payment.refunded',
    aggregateType: 'payment',
    aggregateId: p.id,
    payload: { paymentId: p.id, transactionId: p.transaction_id, orderId: p.order_id, amount: input.amount, refundedAmount: refunded },
  });
  return refund;
}

// ---------------------------------------------------------------------------------------------
// Offline (in-store) payments — recorded by POS, succeed immediately
// ---------------------------------------------------------------------------------------------

export interface OfflinePaymentInput {
  transactionId: string;
  method: OfflineMethod;
  amount: number;
  tenderedAmount?: number | null;
  customMethodId?: string | null;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export async function recordOfflinePayment(ctx: Ctx, input: OfflinePaymentInput) {
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw Errors.validation('金額が不正です');
  await lockKey(ctx, input.idempotencyKey);
  const existing = await ctx.trx.selectFrom('payments').selectAll().where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
  if (existing) {
    replayCheck(existing, { amount: input.amount, transactionId: input.transactionId });
    if (existing.method !== input.method) throw Errors.business('IDEMPOTENCY_KEY_REUSED', '同じIdempotency-Keyが異なる決済で使用されています');
    return { payment: existing, replayed: true };
  }
  const balance = await outstandingBalance(ctx, { transactionId: input.transactionId });
  if (balance.status !== 'draft') throw Errors.business('TRANSACTION_NOT_DRAFT', '確定済みまたは取消済みの会計には決済できません');
  if (input.amount > balance.outstanding) {
    throw Errors.business('AMOUNT_EXCEEDS_BALANCE', '決済金額が未払い残高を超えています', { outstanding: balance.outstanding });
  }
  let change = 0;
  if (input.method === 'cash') {
    const tendered = input.tenderedAmount ?? input.amount;
    if (tendered < input.amount) throw Errors.business('INSUFFICIENT_TENDER', 'お預かり金額が不足しています');
    change = tendered - input.amount;
  } else if (input.tenderedAmount != null && input.tenderedAmount !== input.amount) {
    throw Errors.validation('お預かり金額は現金のみ指定できます');
  }
  if (input.method === 'custom' && !input.customMethodId) throw Errors.validation('店舗独自決済の種類を指定してください');
  const payment = await ctx.trx
    .insertInto('payments')
    .values({
      organization_id: ctx.actor.organizationId,
      transaction_id: input.transactionId,
      method: input.method,
      custom_method_id: input.method === 'custom' ? input.customMethodId! : null,
      provider: null,
      amount: input.amount,
      tendered_amount: input.method === 'cash' ? (input.tenderedAmount ?? input.amount) : null,
      change_amount: change,
      status: 'succeeded',
      succeeded_at: new Date(),
      idempotency_key: input.idempotencyKey,
      metadata: JSON.stringify(input.metadata ?? {}),
      created_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { payment, replayed: false };
}

/**
 * Cancel a payment that has not captured money: offline lines on a draft, or an online payment
 * still awaiting the payer (the provider intent is cancelled best-effort).
 */
export async function cancelPayment(ctx: Ctx, paymentId: string, opts: { reason?: string; allowSucceededOffline?: boolean } = {}) {
  const p = await ctx.trx.selectFrom('payments').selectAll().where('id', '=', paymentId).forUpdate().executeTakeFirst();
  if (!p) throw Errors.notFound('決済', paymentId);
  if (p.status === 'cancelled') return p;
  const offline = p.method !== 'online';
  if (offline) {
    if (p.status !== 'succeeded' || p.refunded_amount > 0) throw Errors.business('PAYMENT_NOT_CANCELLABLE', 'この決済は取り消せません');
    if (!opts.allowSucceededOffline) {
      // offline lines can only be removed while the transaction is a draft
      const tx = p.transaction_id ? await ctx.trx.selectFrom('transactions').select('status').where('id', '=', p.transaction_id).executeTakeFirst() : null;
      if (!tx || tx.status !== 'draft') throw Errors.business('PAYMENT_NOT_CANCELLABLE', '確定済みの会計の決済は取り消せません(返金を利用してください)');
    }
  } else {
    if (!['pending', 'requires_action'].includes(p.status)) throw Errors.business('PAYMENT_NOT_CANCELLABLE', '完了済みのオンライン決済は取り消せません(返金を利用してください)');
    if (p.provider && p.provider_payment_id) {
      await providerByName(p.provider).cancel(p.provider_payment_id, `${ctx.actor.organizationId}:cancel:${p.id}`);
    }
  }
  const updated = await ctx.trx
    .updateTable('payments')
    .set({ status: 'cancelled', failure_reason: opts.reason ?? null })
    .where('id', '=', paymentId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'payment.cancel', resourceType: 'payment', resourceId: p.id, before: { status: p.status }, after: { status: 'cancelled', reason: opts.reason ?? null } });
  return updated;
}
