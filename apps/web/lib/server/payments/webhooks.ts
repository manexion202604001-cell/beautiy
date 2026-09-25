// Payment provider webhooks: verify → store WebhookEvent (unique provider+eventId) →
// normalize → apply idempotently. Client-side payment state is never trusted; orders and
// tickets only become paid here (or via verified provider lookups in the POS).
import type { Prisma } from '@salonos/db';
import { normalizeSquareEvent, normalizeStripeEvent, verifySquareSignature, verifyStripeSignature, type NormalizedPaymentEvent } from '@salonos/core/integrations/payments';
import { prisma } from '../db';
import { env } from '../env';
import { AppError } from '../errors';
import { audit } from '../audit';
import { readConfig } from '../integrations';
import { checkout, refundTransaction, type PosActor } from '../pos';
import { markOrderPaid } from '../commerce';

export type Provider = 'STRIPE' | 'SQUARE';
export interface WebhookResult { status: number; body: Record<string, unknown> }

/** Candidate secrets: integration addressed by ?k=<webhookKey>, env, then all active integrations. */
async function candidateSecrets(provider: Provider, key: string | null): Promise<{ secret: string; orgId: string | null }[]> {
  const field = provider === 'STRIPE' ? 'webhookSecret' : 'signatureKey';
  if (key) {
    const it = await prisma.integration.findUnique({ where: { webhookKey: key } });
    if (!it || it.provider !== provider) return [];
    const s = readConfig(it.configEnc)[field];
    return s ? [{ secret: s, orgId: it.organizationId }] : [];
  }
  const out: { secret: string; orgId: string | null }[] = [];
  const envSecret = provider === 'STRIPE' ? env.stripe.webhookSecret : env.square.signatureKey;
  if (envSecret) out.push({ secret: envSecret, orgId: null });
  const its = await prisma.integration.findMany({ where: { provider, status: { not: 'PAUSED' } }, take: 50 });
  for (const it of its) {
    const s = readConfig(it.configEnc)[field];
    if (s) out.push({ secret: s, orgId: it.organizationId });
  }
  return out;
}

export async function handlePaymentWebhook(provider: Provider, rawBody: string, headers: Headers, url: URL): Promise<WebhookResult> {
  const key = url.searchParams.get('k');
  const secrets = await candidateSecrets(provider, key);
  let orgScope: string | null | undefined;
  if (provider === 'STRIPE') {
    const sig = headers.get('stripe-signature');
    orgScope = secrets.find((s) => verifyStripeSignature(sig, rawBody, s.secret))?.orgId;
  } else {
    const sig = headers.get('x-square-hmacsha256-signature');
    const notificationUrl = `${env.appUrl}${url.pathname}${url.search}`;
    orgScope = secrets.find((s) => verifySquareSignature(sig, rawBody, s.secret, notificationUrl))?.orgId;
  }
  if (orgScope === undefined) return { status: 400, body: { error: 'invalid signature' } };

  let ev: NormalizedPaymentEvent;
  let raw: any;
  try {
    raw = JSON.parse(rawBody);
    ev = provider === 'STRIPE' ? normalizeStripeEvent(rawBody) : normalizeSquareEvent(rawBody);
  } catch {
    return { status: 400, body: { error: 'invalid payload' } };
  }
  if (!ev.eventId || ev.eventId === 'undefined') return { status: 400, body: { error: 'missing event id' } };

  // Idempotency: one row per (provider, eventId). Replays of processed events are no-ops;
  // FAILED events (transient errors) may be reclaimed by a provider retry.
  let eventRowId: string;
  const inserted = await prisma.webhookEvent.createMany({
    data: [{ provider, eventId: ev.eventId, type: String(raw?.type ?? ev.type), payload: raw as Prisma.InputJsonValue }],
    skipDuplicates: true,
  });
  const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider, eventId: ev.eventId } } });
  if (inserted.count === 1) eventRowId = row.id;
  else {
    if (row.status !== 'FAILED') return { status: 200, body: { ok: true, duplicate: true } };
    const reclaimed = await prisma.webhookEvent.updateMany({ where: { id: row.id, status: 'FAILED' }, data: { status: 'RECEIVED', error: null } });
    if (!reclaimed.count) return { status: 200, body: { ok: true, duplicate: true } };
    eventRowId = row.id;
  }

  try {
    const outcome = provider === 'STRIPE' ? await applyStripe(ev, raw, orgScope) : await applySquare(ev, raw, orgScope);
    await prisma.webhookEvent.update({ where: { id: eventRowId }, data: { status: outcome.processed ? 'PROCESSED' : 'IGNORED', error: outcome.note ?? null, processedAt: new Date() } });
    return { status: 200, body: { ok: true, ...outcome } };
  } catch (e: any) {
    if (e instanceof AppError) {
      // Business rule rejection (amount mismatch, already paid...) — retrying won't help.
      await prisma.webhookEvent.update({ where: { id: eventRowId }, data: { status: 'IGNORED', error: e.message.slice(0, 500), processedAt: new Date() } });
      return { status: 200, body: { ok: true, ignored: e.message } };
    }
    console.error(`[webhook:${provider}]`, e);
    await prisma.webhookEvent.update({ where: { id: eventRowId }, data: { status: 'FAILED', error: String(e?.message ?? e).slice(0, 500) } });
    return { status: 500, body: { error: 'processing failed' } };
  }
}

interface Outcome { processed: boolean; note?: string }

const systemActor = (orgId: string, shopId: string): PosActor => ({ orgId, userId: null, shopIds: [shopId] });

function inScope(orgScope: string | null, orgId: string) {
  // Events verified with an organization's own secret may only touch that organization.
  return orgScope === null || orgScope === orgId;
}

/** Provider payment for a POS ticket (pay-by-link / terminal). */
async function applyTransactionPayment(orgScope: string | null, provider: Provider, txId: string, externalRef: string | undefined, amount: number | undefined): Promise<Outcome> {
  if (externalRef) {
    const existing = await prisma.payment.findUnique({ where: { externalRef } });
    if (existing) {
      if (existing.status === 'PENDING') await prisma.payment.update({ where: { id: existing.id }, data: { status: 'SUCCEEDED' } });
      return { processed: true, note: 'payment already recorded' };
    }
  }
  const t = await prisma.transaction.findUnique({ where: { id: txId }, select: { id: true, organizationId: true, shopId: true, status: true, total: true } });
  if (!t || !inScope(orgScope, t.organizationId)) return { processed: false, note: 'transaction not found' };
  if (t.status !== 'DRAFT') return { processed: false, note: `transaction is ${t.status}` };
  if (amount == null) return { processed: false, note: 'missing amount' };
  await checkout(systemActor(t.organizationId, t.shopId), t.id, { tenders: [{ method: provider, amount, externalRef: externalRef ?? null, label: 'オンライン決済' }] }, { providerVerified: true });
  return { processed: true };
}

async function applyOrderPaid(orgScope: string | null, provider: Provider, orderId: string, paymentRef: string | undefined, amount: number | undefined): Promise<Outcome> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { organizationId: true } });
  if (!order || !inScope(orgScope, order.organizationId)) return { processed: false, note: 'order not found' };
  const r = await markOrderPaid(orderId, { provider, paymentRef: paymentRef ?? null, amount: amount ?? null });
  if (r.changed) await audit({ orgId: order.organizationId, userId: null }, 'commerce.order.paid', 'Order', orderId, { provider, paymentRef });
  return { processed: r.changed, note: r.reason };
}

async function applyOrderRefund(orgScope: string | null, orderId: string, refundedAmount: number): Promise<Outcome> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || !inScope(orgScope, order.organizationId)) return { processed: false, note: 'order not found' };
  if (order.status !== 'PAID' && order.status !== 'FULFILLED') return { processed: false, note: `order is ${order.status}` };
  if (refundedAmount < order.total) return { processed: false, note: 'partial refund recorded at provider only' };
  await prisma.$transaction(async (tx) => {
    const r = await tx.order.updateMany({ where: { id: orderId, status: order.status }, data: { status: 'REFUNDED' } });
    if (!r.count) return;
    await tx.subscription.updateMany({ where: { orderId, status: { not: 'CANCELLED' } }, data: { status: 'CANCELLED' } });
    await audit({ orgId: order.organizationId, userId: null }, 'commerce.order.refunded', 'Order', orderId, { source: 'webhook', amount: refundedAmount }, tx);
  });
  return { processed: true };
}

/** Record provider-side refunds on a POS ticket; Refund.externalRef makes each one-shot. */
async function applyTransactionRefunds(orgScope: string | null, method: Provider, paymentRef: string, refunds: { id: string; amount: number }[]): Promise<Outcome> {
  const payment = await prisma.payment.findUnique({ where: { externalRef: paymentRef }, include: { transaction: { select: { id: true, organizationId: true, shopId: true } } } });
  if (!payment || !inScope(orgScope, payment.transaction.organizationId)) return { processed: false, note: 'payment not found' };
  let applied = 0;
  for (const r of refunds) {
    if (r.amount <= 0) continue;
    const res = await refundTransaction(systemActor(payment.transaction.organizationId, payment.transaction.shopId), payment.transaction.id, {
      amount: r.amount, method, externalRef: r.id, reason: `${method === 'STRIPE' ? 'Stripe' : 'Square'}で返金`,
    });
    if (!res.duplicate) applied++;
  }
  return { processed: applied > 0, note: applied ? undefined : 'refunds already recorded' };
}

async function applyStripe(ev: NormalizedPaymentEvent, raw: any, orgScope: string | null): Promise<Outcome> {
  const obj = raw?.data?.object ?? {};
  const type: string = raw?.type ?? '';
  if (ev.type === 'payment.succeeded') {
    if (type === 'checkout.session.completed' && obj.payment_status && obj.payment_status !== 'paid') return { processed: false, note: `payment_status ${obj.payment_status}` };
    if (!ev.referenceId) return { processed: false, note: 'no reference metadata' };
    if (ev.referenceKind === 'order') return applyOrderPaid(orgScope, 'STRIPE', ev.referenceId, ev.externalRef, ev.amount);
    return applyTransactionPayment(orgScope, 'STRIPE', ev.referenceId, ev.externalRef, ev.amount);
  }
  if (ev.type === 'refund.succeeded' || ((type === 'refund.created' || type === 'refund.updated') && obj.status === 'succeeded')) {
    const pi: string | undefined = obj.payment_intent ?? undefined;
    if (!pi) return { processed: false, note: 'no payment_intent' };
    const order = await prisma.order.findUnique({ where: { paymentRef: pi }, select: { id: true } });
    if (type === 'charge.refunded') {
      if (order) return applyOrderRefund(orgScope, order.id, obj.amount_refunded ?? 0);
      let list: { id: string; amount: number }[] = (obj.refunds?.data ?? []).filter((r: any) => r.status === 'succeeded').map((r: any) => ({ id: r.id, amount: r.amount }));
      if (!list.length) {
        // refunds not expanded: record the not-yet-known remainder once, keyed by event id
        const pay = await prisma.payment.findUnique({ where: { externalRef: pi }, select: { transactionId: true } });
        if (!pay) return { processed: false, note: 'payment not found' };
        const known = await prisma.refund.aggregate({ where: { transactionId: pay.transactionId, method: 'STRIPE' }, _sum: { amount: true } });
        const delta = (obj.amount_refunded ?? 0) - (known._sum.amount ?? 0);
        list = delta > 0 ? [{ id: `stripe_evt_${ev.eventId}`, amount: delta }] : [];
      }
      return applyTransactionRefunds(orgScope, 'STRIPE', pi, list);
    }
    // refund.* object
    if (order) return { processed: false, note: 'order refunds are reconciled via charge.refunded' };
    return applyTransactionRefunds(orgScope, 'STRIPE', pi, [{ id: obj.id, amount: obj.amount }]);
  }
  return { processed: false, note: `unhandled ${type}` };
}

async function applySquare(ev: NormalizedPaymentEvent, raw: any, orgScope: string | null): Promise<Outcome> {
  const obj = raw?.data?.object ?? {};
  if (ev.type === 'payment.succeeded') {
    const p = obj.payment ?? {};
    if (ev.referenceId && ev.referenceKind === 'order') return applyOrderPaid(orgScope, 'SQUARE', ev.referenceId, p.id, ev.amount);
    if (ev.referenceId && ev.referenceKind === 'transaction') return applyTransactionPayment(orgScope, 'SQUARE', ev.referenceId, p.id, ev.amount);
    // Payment links: the payment references the Square order we stored as Order.paymentRef.
    if (p.order_id) {
      const order = await prisma.order.findUnique({ where: { paymentRef: p.order_id }, select: { id: true } });
      if (order) return applyOrderPaid(orgScope, 'SQUARE', order.id, p.id, ev.amount);
    }
    return { processed: false, note: 'no reference' };
  }
  if (ev.type === 'refund.succeeded') {
    const r = obj.refund ?? {};
    if (!r.payment_id) return { processed: false, note: 'no payment_id' };
    const order = await prisma.order.findUnique({ where: { paymentRef: r.payment_id }, select: { id: true } });
    if (order) return applyOrderRefund(orgScope, order.id, r.amount_money?.amount ?? 0);
    return applyTransactionRefunds(orgScope, 'SQUARE', r.payment_id, [{ id: r.id, amount: r.amount_money?.amount ?? 0 }]);
  }
  return { processed: false, note: `unhandled ${raw?.type}` };
}
