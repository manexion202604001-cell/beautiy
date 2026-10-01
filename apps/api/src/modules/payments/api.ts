import { randomUUID } from 'node:crypto';
import { auditUserId, type Ctx } from '../../auth/actor.js';
import { Errors } from '../../lib/errors.js';
import { emit } from '../../lib/events.js';

/**
 * PUBLIC CONTRACT of the payments module (FR-05). Other modules (POS, commerce) start online
 * payments and refunds ONLY through these functions. Results arrive asynchronously:
 *   domain events 'payment.succeeded' | 'payment.failed' | 'payment.refunded'
 *   payload: { paymentId, transactionId: string|null, orderId: string|null, amount, refundedAmount? }
 * Guarantees: one payment row per (organization, idempotencyKey); provider payment id unique.
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

export async function startOnlinePayment(ctx: Ctx, input: StartOnlinePaymentInput): Promise<OnlinePaymentResult> {
  if ((input.transactionId ? 1 : 0) + (input.orderId ? 1 : 0) !== 1) throw Errors.validation('transactionIdかorderIdのどちらか一方を指定してください');
  if (input.amount <= 0) throw Errors.validation('金額が不正です');
  const existing = await ctx.trx.selectFrom('payments').selectAll().where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
  if (existing) {
    if (existing.amount !== input.amount || existing.transaction_id !== (input.transactionId ?? null) || existing.order_id !== (input.orderId ?? null)) {
      throw Errors.business('IDEMPOTENCY_KEY_REUSED', '同じIdempotency-Keyが異なる決済で使用されています');
    }
    return {
      paymentId: existing.id,
      status: existing.status,
      provider: existing.provider ?? 'mock',
      providerPaymentId: existing.provider_payment_id,
      clientSecret: existing.client_secret,
      replayed: true,
    };
  }
  // Minimal mock provider; the payments module replaces this with its provider adapters (mock/stripe).
  const providerPaymentId = `mock_pi_${randomUUID()}`;
  const row = await ctx.trx
    .insertInto('payments')
    .values({
      organization_id: ctx.actor.organizationId,
      transaction_id: input.transactionId ?? null,
      order_id: input.orderId ?? null,
      method: 'online',
      provider: 'mock',
      provider_payment_id: providerPaymentId,
      amount: input.amount,
      status: 'requires_action',
      idempotency_key: input.idempotencyKey,
      client_secret: `${providerPaymentId}_secret`,
      metadata: JSON.stringify(input.metadata ?? {}),
      created_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .returning(['id', 'status', 'provider', 'provider_payment_id', 'client_secret'])
    .executeTakeFirstOrThrow();
  return { paymentId: row.id, status: row.status, provider: row.provider!, providerPaymentId: row.provider_payment_id, clientSecret: row.client_secret, replayed: false };
}

/**
 * Mark a pending online payment as succeeded/failed (used by provider webhooks and by the mock
 * provider in dev/test). Idempotent: repeated calls for a final state are no-ops.
 */
export async function settleOnlinePayment(ctx: Ctx, paymentId: string, outcome: { success: boolean; failureCode?: string; failureReason?: string }) {
  const p = await ctx.trx.selectFrom('payments').selectAll().where('id', '=', paymentId).forUpdate().executeTakeFirst();
  if (!p) throw Errors.notFound('決済', paymentId);
  if (['succeeded', 'failed', 'cancelled', 'refunded', 'partially_refunded'].includes(p.status)) return p;
  const status = outcome.success ? 'succeeded' : 'failed';
  const updated = await ctx.trx
    .updateTable('payments')
    .set({ status, succeeded_at: outcome.success ? new Date() : null, failure_code: outcome.failureCode ?? null, failure_reason: outcome.failureReason ?? null })
    .where('id', '=', paymentId)
    .returningAll()
    .executeTakeFirstOrThrow();
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
}

export async function refundPayment(ctx: Ctx, input: RefundInput) {
  const p = await ctx.trx.selectFrom('payments').selectAll().where('id', '=', input.paymentId).forUpdate().executeTakeFirst();
  if (!p) throw Errors.notFound('決済', input.paymentId);
  const existing = await ctx.trx.selectFrom('refunds').selectAll().where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
  if (existing) return existing;
  if (!['succeeded', 'partially_refunded'].includes(p.status)) throw Errors.business('PAYMENT_NOT_REFUNDABLE', 'この決済は返金できません');
  if (input.amount <= 0 || p.refunded_amount + input.amount > p.amount) throw Errors.business('REFUND_EXCEEDS_PAYMENT', '返金額が決済額を超えています');
  const refund = await ctx.trx
    .insertInto('refunds')
    .values({
      organization_id: ctx.actor.organizationId,
      payment_id: p.id,
      amount: input.amount,
      reason: input.reason ?? null,
      status: 'succeeded',
      idempotency_key: input.idempotencyKey,
      provider_refund_id: p.provider ? `mock_re_${randomUUID()}` : null,
      created_by: auditUserId(ctx.actor),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const refunded = p.refunded_amount + input.amount;
  await ctx.trx
    .updateTable('payments')
    .set({ refunded_amount: refunded, status: refunded >= p.amount ? 'refunded' : 'partially_refunded' })
    .where('id', '=', p.id)
    .execute();
  await emit(ctx, {
    type: 'payment.refunded',
    aggregateType: 'payment',
    aggregateId: p.id,
    payload: { paymentId: p.id, transactionId: p.transaction_id, orderId: p.order_id, amount: input.amount, refundedAmount: refunded },
  });
  return refund;
}
