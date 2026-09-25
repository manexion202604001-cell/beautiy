// Payment provider webhook verification (Stripe / Square) without SDK dependencies.
import { hmacBase64, hmacHex, safeEqual } from '../crypto';

/** Stripe-Signature: t=timestamp,v1=hex(HMAC_SHA256(secret, `${t}.${body}`)) */
export function verifyStripeSignature(header: string | null, rawBody: string, secret: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]; }));
  const t = Number(parts.t);
  if (!t || Math.abs(nowSec - t) > toleranceSec) return false;
  const sigs = header.split(',').filter((kv) => kv.trim().startsWith('v1=')).map((kv) => kv.trim().slice(3));
  const expected = hmacHex(secret, `${t}.${rawBody}`);
  return sigs.some((s) => safeEqual(s, expected));
}

export function signStripePayload(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${hmacHex(secret, `${t}.${rawBody}`)}`;
}

/** x-square-hmacsha256-signature: base64(HMAC_SHA256(signatureKey, notificationUrl + body)) */
export function verifySquareSignature(header: string | null, rawBody: string, signatureKey: string, notificationUrl: string): boolean {
  if (!header || !signatureKey) return false;
  return safeEqual(header, hmacBase64(signatureKey, notificationUrl + rawBody));
}

export interface NormalizedPaymentEvent {
  eventId: string;
  type: 'payment.succeeded' | 'payment.failed' | 'refund.succeeded' | 'other';
  externalRef?: string;
  amount?: number;
  /** our Transaction/Order id carried in provider metadata */
  referenceId?: string;
  referenceKind?: 'transaction' | 'order';
}

export function normalizeStripeEvent(rawBody: string): NormalizedPaymentEvent {
  const e = JSON.parse(rawBody);
  const obj = e?.data?.object ?? {};
  const md = obj.metadata ?? {};
  const referenceKind = md.order_id ? 'order' : md.transaction_id ? 'transaction' : undefined;
  const referenceId = md.order_id ?? md.transaction_id;
  const map: Record<string, NormalizedPaymentEvent['type']> = {
    'payment_intent.succeeded': 'payment.succeeded',
    'checkout.session.completed': 'payment.succeeded',
    'payment_intent.payment_failed': 'payment.failed',
    'charge.refunded': 'refund.succeeded',
  };
  return {
    eventId: String(e.id), type: map[e.type] ?? 'other',
    externalRef: obj.payment_intent ?? obj.id, amount: obj.amount_received ?? obj.amount_total ?? obj.amount_refunded ?? obj.amount,
    referenceId, referenceKind,
  };
}

export function normalizeSquareEvent(rawBody: string): NormalizedPaymentEvent {
  const e = JSON.parse(rawBody);
  const p = e?.data?.object?.payment ?? e?.data?.object?.refund ?? {};
  let type: NormalizedPaymentEvent['type'] = 'other';
  if (e.type === 'payment.updated' || e.type === 'payment.created') type = p.status === 'COMPLETED' ? 'payment.succeeded' : p.status === 'FAILED' ? 'payment.failed' : 'other';
  if (e.type === 'refund.updated' && p.status === 'COMPLETED') type = 'refund.succeeded';
  const ref: string | undefined = p.reference_id;
  return {
    eventId: String(e.event_id), type, externalRef: p.id, amount: p.amount_money?.amount,
    referenceId: ref?.replace(/^(txn|ord):/, ''), referenceKind: ref?.startsWith('ord:') ? 'order' : ref ? 'transaction' : undefined,
  };
}
