import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Ctx } from '../../auth/actor.js';
import { config } from '../../config.js';
import { withSystem } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { sha256 } from '../../lib/crypto.js';
import { emit } from '../../lib/events.js';
import type { IncomingWebhook, VerifiedWebhook, WebhookProvider } from '../../lib/webhooks.js';
import { settleOnlinePayment } from './api.js';
import { mapRefundStatus } from './providers/stripe.js';

/** Stripe signature tolerance (seconds) */
export const STRIPE_TOLERANCE_SEC = 300;

export interface SignatureCheck {
  valid: boolean;
  reason?: 'missing_secret' | 'missing_header' | 'malformed_header' | 'timestamp_out_of_tolerance' | 'signature_mismatch';
  timestamp?: number;
}

/**
 * Verify a `Stripe-Signature` header: `t=<unix>,v1=<hex hmac>[,v1=...]` where
 * v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). Constant-time comparison, ±5 minute tolerance.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | string[] | undefined,
  secret: string | undefined,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = STRIPE_TOLERANCE_SEC,
): SignatureCheck {
  if (!secret) return { valid: false, reason: 'missing_secret' };
  const h = Array.isArray(header) ? header[0] : header;
  if (!h) return { valid: false, reason: 'missing_header' };
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of h.split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === 't' && /^\d+$/.test(v)) t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]+$/i.test(v)) sigs.push(v.toLowerCase());
  }
  if (t === null || sigs.length === 0) return { valid: false, reason: 'malformed_header' };
  if (Math.abs(nowSec - t) > toleranceSec) return { valid: false, reason: 'timestamp_out_of_tolerance', timestamp: t };
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  const ok = sigs.some((s) => {
    const b = Buffer.from(s);
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
  return ok ? { valid: true, timestamp: t } : { valid: false, reason: 'signature_mismatch', timestamp: t };
}

/** Build a header value (for tests / local tooling) */
export function signStripePayload(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}

interface StripeEvent {
  id?: string;
  type?: string;
  data?: { object?: Record<string, any> };
}

/** provider payment id (PaymentIntent id) referenced by an event object */
export function paymentIntentIdOf(obj: Record<string, any> | undefined): string | null {
  if (!obj) return null;
  if (obj.object === 'payment_intent' && typeof obj.id === 'string') return obj.id;
  if (typeof obj.payment_intent === 'string') return obj.payment_intent;
  if (obj.payment_intent && typeof obj.payment_intent.id === 'string') return obj.payment_intent.id;
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveOrganization(obj: Record<string, any> | undefined): Promise<string | null> {
  const pi = paymentIntentIdOf(obj);
  if (pi) {
    const row = await withSystem((trx) =>
      trx.selectFrom('payments').select('organization_id').where('provider', '=', 'stripe').where('provider_payment_id', '=', pi).executeTakeFirst(),
    );
    if (row) return row.organization_id;
  }
  const metaOrg = obj?.metadata?.organization_id;
  if (typeof metaOrg === 'string' && UUID_RE.test(metaOrg)) {
    const org = await withSystem((trx) => trx.selectFrom('organizations').select('id').where('id', '=', metaOrg).executeTakeFirst());
    if (org) return org.id;
  }
  return null;
}

export async function verifyStripeWebhook(req: IncomingWebhook, secret = config.STRIPE_WEBHOOK_SECRET): Promise<VerifiedWebhook> {
  const check = verifyStripeSignature(req.rawBody, req.headers['stripe-signature'], secret);
  let event: StripeEvent;
  try {
    event = (req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.rawBody)) as StripeEvent;
  } catch {
    event = {};
  }
  const eventId = typeof event.id === 'string' ? event.id : `sha256:${sha256(req.rawBody)}`;
  if (!check.valid) return { eventId, eventType: event.type, organizationId: null, signatureValid: false };
  return { eventId, eventType: event.type, organizationId: await resolveOrganization(event.data?.object), signatureValid: true };
}

async function findPayment(ctx: Ctx, providerPaymentId: string | null) {
  if (!providerPaymentId) return null;
  return ctx.trx.selectFrom('payments').selectAll().where('provider', '=', 'stripe').where('provider_payment_id', '=', providerPaymentId).forUpdate().executeTakeFirst() ?? null;
}

type PaymentRow = NonNullable<Awaited<ReturnType<typeof findPayment>>>;

async function setRefundedAmount(ctx: Ctx, p: PaymentRow, refunded: number) {
  const status = refunded <= 0 ? 'succeeded' : refunded >= p.amount ? 'refunded' : 'partially_refunded';
  await ctx.trx.updateTable('payments').set({ refunded_amount: refunded, status }).where('id', '=', p.id).execute();
  p.refunded_amount = refunded;
  p.status = status;
}

/** Apply one provider refund (created in our system or directly in the Stripe dashboard). Idempotent. */
async function applyProviderRefund(ctx: Ctx, p: PaymentRow, re: { id: string; amount: number; status?: string; reason?: string | null }): Promise<boolean> {
  const status = mapRefundStatus(re.status);
  const existing = await ctx.trx.selectFrom('refunds').selectAll().where('provider_refund_id', '=', re.id).executeTakeFirst();
  if (existing) {
    if (existing.status === status) return false;
    await ctx.trx.updateTable('refunds').set({ status }).where('id', '=', existing.id).execute();
    if (status === 'failed' && existing.status !== 'failed') await setRefundedAmount(ctx, p, Math.max(0, p.refunded_amount - existing.amount));
    if (existing.status === 'failed' && status !== 'failed') await setRefundedAmount(ctx, p, Math.min(p.amount, p.refunded_amount + existing.amount));
    await audit(ctx, { action: 'payment.refund_status', resourceType: 'refund', resourceId: existing.id, before: { status: existing.status }, after: { status } });
    return true;
  }
  if (status === 'failed') return false;
  const amount = Math.min(re.amount, p.amount - p.refunded_amount);
  if (amount <= 0) return false;
  const refund = await ctx.trx
    .insertInto('refunds')
    .values({
      organization_id: ctx.actor.organizationId,
      payment_id: p.id,
      amount,
      reason: re.reason ?? '決済サービス側で返金',
      provider_refund_id: re.id,
      status,
      idempotency_key: `stripe:${re.id}`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await setRefundedAmount(ctx, p, p.refunded_amount + amount);
  await audit(ctx, { action: 'payment.refund_external', resourceType: 'refund', resourceId: refund.id, after: { paymentId: p.id, amount, providerRefundId: re.id } });
  await emit(ctx, {
    type: 'payment.refunded',
    aggregateType: 'payment',
    aggregateId: p.id,
    payload: { paymentId: p.id, transactionId: p.transaction_id, orderId: p.order_id, amount, refundedAmount: p.refunded_amount },
  });
  return true;
}

export async function processStripeEvent(ctx: Ctx, event: { eventId: string; eventType: string | null; payload: unknown }): Promise<'processed' | 'ignored'> {
  const ev = (event.payload ?? {}) as StripeEvent;
  const type = event.eventType ?? ev.type ?? '';
  const obj = ev.data?.object ?? {};
  switch (type) {
    case 'payment_intent.succeeded': {
      const p = await findPayment(ctx, paymentIntentIdOf(obj));
      if (!p) return 'ignored';
      const received = typeof obj.amount_received === 'number' ? obj.amount_received : obj.amount;
      if (p.status === 'cancelled') {
        // money captured for an intent we had already cancelled locally: flag for reconciliation
        await audit(ctx, { action: 'payment.succeeded_after_cancel', resourceType: 'payment', resourceId: p.id, metadata: { eventId: event.eventId, received } });
        return 'processed';
      }
      if (typeof received === 'number' && received !== p.amount) {
        await audit(ctx, { action: 'payment.amount_mismatch', resourceType: 'payment', resourceId: p.id, metadata: { expected: p.amount, received, eventId: event.eventId } });
        return 'ignored';
      }
      await settleOnlinePayment(ctx, p.id, { success: true });
      return 'processed';
    }
    case 'payment_intent.payment_failed': {
      const p = await findPayment(ctx, paymentIntentIdOf(obj));
      if (!p) return 'ignored';
      const err = obj.last_payment_error ?? {};
      await settleOnlinePayment(ctx, p.id, {
        success: false,
        failureCode: (err.decline_code as string | undefined) ?? (err.code as string | undefined) ?? 'payment_failed',
        failureReason: typeof err.message === 'string' ? err.message.slice(0, 500) : '決済に失敗しました',
      });
      return 'processed';
    }
    case 'payment_intent.canceled': {
      const p = await findPayment(ctx, paymentIntentIdOf(obj));
      if (!p) return 'ignored';
      if (['pending', 'requires_action'].includes(p.status)) {
        await ctx.trx.updateTable('payments').set({ status: 'cancelled', failure_reason: '決済サービス側で取消' }).where('id', '=', p.id).execute();
        await audit(ctx, { action: 'payment.cancel', resourceType: 'payment', resourceId: p.id, before: { status: p.status }, after: { status: 'cancelled' } });
      }
      return 'processed';
    }
    case 'charge.refunded': {
      const p = await findPayment(ctx, paymentIntentIdOf(obj));
      if (!p) return 'ignored';
      const list: any[] = Array.isArray(obj.refunds?.data) ? obj.refunds.data : [];
      for (const re of list) {
        if (typeof re?.id === 'string' && typeof re.amount === 'number') await applyProviderRefund(ctx, p, { id: re.id, amount: re.amount, status: re.status, reason: re.reason });
      }
      // newer API versions omit the refunds list: reconcile on amount_refunded
      if (typeof obj.amount_refunded === 'number' && obj.amount_refunded > p.refunded_amount) {
        const diff = Math.min(obj.amount_refunded, p.amount) - p.refunded_amount;
        if (diff > 0) {
          const key = `stripe:${String(obj.id)}:${obj.amount_refunded}`;
          const dup = await ctx.trx.selectFrom('refunds').select('id').where('idempotency_key', '=', key).executeTakeFirst();
          if (!dup) {
            await ctx.trx
              .insertInto('refunds')
              .values({ organization_id: ctx.actor.organizationId, payment_id: p.id, amount: diff, reason: '決済サービス側で返金', status: 'succeeded', idempotency_key: key })
              .execute();
            await setRefundedAmount(ctx, p, p.refunded_amount + diff);
            await emit(ctx, {
              type: 'payment.refunded',
              aggregateType: 'payment',
              aggregateId: p.id,
              payload: { paymentId: p.id, transactionId: p.transaction_id, orderId: p.order_id, amount: diff, refundedAmount: p.refunded_amount },
            });
          }
        }
      }
      // pending refunds created by us become succeeded once Stripe reports the charge refunded
      if (!list.length) {
        await ctx.trx.updateTable('refunds').set({ status: 'succeeded' }).where('payment_id', '=', p.id).where('status', '=', 'pending').execute();
      }
      return 'processed';
    }
    case 'charge.refund.updated':
    case 'refund.updated': {
      if (typeof obj.id !== 'string') return 'ignored';
      const p = await findPayment(ctx, paymentIntentIdOf(obj));
      if (!p) return 'ignored';
      await applyProviderRefund(ctx, p, { id: obj.id, amount: Number(obj.amount ?? 0), status: obj.status, reason: obj.reason });
      return 'processed';
    }
    default:
      return 'ignored';
  }
}

export const stripeWebhookProvider: WebhookProvider = {
  verify: (req) => verifyStripeWebhook(req),
  process: processStripeEvent,
};
