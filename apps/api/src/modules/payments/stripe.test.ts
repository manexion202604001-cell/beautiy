import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../../config.js';
import { getWebhookProvider } from '../../lib/webhooks.js';
import { asSystem, getApp } from '../../test/helpers.js';
import { key, openRegister, posSetup, quickSale } from '../pos/test-utils.js';
import { refundPayment, startOnlinePayment } from './api.js';
import { setPaymentProviderOverride } from './providers/index.js';
import { createStripeProvider, formEncode } from './providers/stripe.js';
import { processStripeEvent, signStripePayload, verifyStripeSignature, verifyStripeWebhook } from './webhook.js';

const SECRET = 'whsec_test_secret';
const SK = 'sk_test_DO_NOT_LEAK_123';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: URLSearchParams;
}

/** fake fetch emulating the Stripe REST API (no network) */
function fakeStripe(opts: { failWith?: { status: number; body: unknown } } = {}) {
  const calls: Captured[] = [];
  const run = Math.random().toString(36).slice(2, 8);
  let n = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ url: String(url), headers, body });
    if (opts.failWith) return new Response(JSON.stringify(opts.failWith.body), { status: opts.failWith.status, headers: { 'request-id': 'req_123' } });
    n++;
    if (String(url).endsWith('/payment_intents')) {
      return Response.json({ id: `pi_${run}_${n}_${body.get('amount')}`, object: 'payment_intent', client_secret: `pi_${run}_${n}_secret_x`, status: 'requires_payment_method' });
    }
    if (String(url).endsWith('/refunds')) return Response.json({ id: `re_${run}_${n}`, object: 'refund', status: 'succeeded', amount: Number(body.get('amount')) });
    if (String(url).includes('/cancel')) return Response.json({ id: 'pi', status: 'canceled' });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

afterEach(() => setPaymentProviderOverride(null));

describe('Stripe-Signature verification', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
  const now = Math.floor(Date.now() / 1000);

  it('accepts a valid signature (also with multiple v1 values)', () => {
    expect(verifyStripeSignature(body, signStripePayload(body, SECRET, now), SECRET, now)).toMatchObject({ valid: true, timestamp: now });
    const multi = `t=${now},v1=${'0'.repeat(64)},${signStripePayload(body, SECRET, now).split(',')[1]}`;
    expect(verifyStripeSignature(body, multi, SECRET, now).valid).toBe(true);
  });

  it('rejects tampered payloads, wrong secrets and malformed headers', () => {
    const header = signStripePayload(body, SECRET, now);
    expect(verifyStripeSignature(body + ' ', header, SECRET, now)).toMatchObject({ valid: false, reason: 'signature_mismatch' });
    expect(verifyStripeSignature(body, header, 'whsec_other', now)).toMatchObject({ valid: false, reason: 'signature_mismatch' });
    expect(verifyStripeSignature(body, 'garbage', SECRET, now)).toMatchObject({ valid: false, reason: 'malformed_header' });
    expect(verifyStripeSignature(body, `t=${now},v1=zz`, SECRET, now)).toMatchObject({ valid: false, reason: 'malformed_header' });
    expect(verifyStripeSignature(body, undefined, SECRET, now)).toMatchObject({ valid: false, reason: 'missing_header' });
    expect(verifyStripeSignature(body, header, undefined, now)).toMatchObject({ valid: false, reason: 'missing_secret' });
  });

  it('rejects signatures outside the 5 minute tolerance (replay protection)', () => {
    const old = now - 301;
    expect(verifyStripeSignature(body, signStripePayload(body, SECRET, old), SECRET, now)).toMatchObject({ valid: false, reason: 'timestamp_out_of_tolerance' });
    expect(verifyStripeSignature(body, signStripePayload(body, SECRET, now - 299), SECRET, now).valid).toBe(true);
    expect(verifyStripeSignature(body, signStripePayload(body, SECRET, now + 301), SECRET, now).valid).toBe(false);
  });

  it('is registered as the "stripe" webhook provider using STRIPE_WEBHOOK_SECRET', async () => {
    await getApp(); // loads all modules (registration side effects)
    const provider = getWebhookProvider('stripe');
    expect(provider).toBeDefined();
    const prev = config.STRIPE_WEBHOOK_SECRET;
    (config as { STRIPE_WEBHOOK_SECRET?: string }).STRIPE_WEBHOOK_SECRET = SECRET;
    try {
      const ok = await provider!.verify({ provider: 'stripe', headers: { 'stripe-signature': signStripePayload(body, SECRET) }, rawBody: body, body: JSON.parse(body) });
      expect(ok).toMatchObject({ eventId: 'evt_1', eventType: 'payment_intent.succeeded', signatureValid: true, organizationId: null });
      const bad = await provider!.verify({ provider: 'stripe', headers: { 'stripe-signature': signStripePayload(body, 'nope') }, rawBody: body, body: JSON.parse(body) });
      expect(bad.signatureValid).toBe(false);
    } finally {
      (config as { STRIPE_WEBHOOK_SECRET?: string }).STRIPE_WEBHOOK_SECRET = prev;
    }
  });
});

describe('Stripe adapter', () => {
  it('creates PaymentIntents form-encoded with a tenant-scoped Idempotency-Key and refunds via /refunds', async () => {
    const { t, menu } = await posSetup();
    await openRegister(t.owner, t.shopId);
    const fake = fakeStripe();
    setPaymentProviderOverride(createStripeProvider({ secretKey: SK, fetchImpl: fake.fetchImpl }));
    const draft = await quickSale(t.owner, t.shopId, [{ type: 'service', menuId: menu.id }], { complete: false, method: 'card' });
    const card = (await t.owner.get(`/v1/transactions/${draft.id}`)).body.payments[0];
    await t.owner.delete(`/v1/transactions/${draft.id}/payments/${card.id}`);

    const k = key('stripe');
    const res = await t.owner.post('/v1/payments', { transactionId: draft.id, idempotencyKey: k });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ provider: 'stripe', status: 'requires_action', amount: 5500 });
    expect(res.body.provider_payment_id).toMatch(/^pi_\w+_1_5500$/);
    expect(res.body.client_secret).toMatch(/^pi_\w+_1_secret_x$/);
    const call = fake.calls[0]!;
    expect(call.url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(call.headers.authorization).toBe(`Bearer ${SK}`);
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(call.headers['idempotency-key']).toBe(`${t.organizationId}:${k}`);
    expect(call.body.get('amount')).toBe('5500');
    expect(call.body.get('currency')).toBe('jpy');
    expect(call.body.get('metadata[organization_id]')).toBe(t.organizationId);
    expect(call.body.get('metadata[transaction_id]')).toBe(draft.id);
    expect(call.body.get('metadata[payment_id]')).toBe(res.body.id);

    // webhook verify resolves the tenant from the payment row
    const evt = { id: 'evt_pi_ok', type: 'payment_intent.succeeded', data: { object: { id: res.body.provider_payment_id, object: 'payment_intent', amount: 5500, amount_received: 5500 } } };
    const raw = JSON.stringify(evt);
    const verified = await verifyStripeWebhook({ provider: 'stripe', headers: { 'stripe-signature': signStripePayload(raw, SECRET) }, rawBody: raw, body: evt }, SECRET);
    expect(verified).toMatchObject({ eventId: 'evt_pi_ok', signatureValid: true, organizationId: t.organizationId });

    // process twice (duplicate delivery) → one success event
    for (let i = 0; i < 2; i++) {
      const r = await asSystem(t.organizationId, (ctx) => processStripeEvent(ctx, { eventId: evt.id, eventType: evt.type, payload: evt }));
      expect(r).toBe('processed');
    }
    const succeeded = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('domain_events').select('id').where('aggregate_id', '=', res.body.id).where('event_type', '=', 'payment.succeeded').execute(),
    );
    expect(succeeded).toHaveLength(1);
    expect((await t.owner.post(`/v1/transactions/${draft.id}/complete`)).status).toBe(200);

    // refund through the adapter
    const rf = await t.owner.post(`/v1/payments/${res.body.id}/refund`, { amount: 2000, reason: '返金', idempotencyKey: 'rf-1' });
    expect(rf.status).toBe(200);
    const refundCall = fake.calls.find((c) => c.url.endsWith('/refunds'))!;
    expect(refundCall.body.get('payment_intent')).toBe(res.body.provider_payment_id);
    expect(refundCall.body.get('amount')).toBe('2000');
    expect(refundCall.headers['idempotency-key']).toBe(`${t.organizationId}:refund:rf-1`);
    expect(rf.body.refunds[0]).toMatchObject({ amount: 2000, status: 'succeeded' });
    const providerRefundId = rf.body.refunds[0].provider_refund_id;

    // charge.refunded for our own refund + one made in the Stripe dashboard; delivered twice
    const charge = {
      id: 'evt_ch_1',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_1',
          object: 'charge',
          payment_intent: res.body.provider_payment_id,
          amount_refunded: 3000,
          refunds: { data: [{ id: providerRefundId, amount: 2000, status: 'succeeded' }, { id: `re_dash_${draft.id}`, amount: 1000, status: 'succeeded' }] },
        },
      },
    };
    for (let i = 0; i < 2; i++) await asSystem(t.organizationId, (ctx) => processStripeEvent(ctx, { eventId: charge.id, eventType: charge.type, payload: charge }));
    const p = await t.owner.get(`/v1/payments/${res.body.id}`);
    expect(p.body).toMatchObject({ status: 'partially_refunded', refunded_amount: 3000 });
    expect(p.body.refunds).toHaveLength(2);
    const tx = await t.owner.get(`/v1/transactions/${draft.id}`);
    expect(tx.body).toMatchObject({ status: 'partially_refunded', refunded_total: 3000 });
    const refundedEvents = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('domain_events').select('id').where('aggregate_id', '=', res.body.id).where('event_type', '=', 'payment.refunded').execute(),
    );
    expect(refundedEvents).toHaveLength(2); // our refund + the dashboard refund, not duplicated

    // newer API versions: no refunds list, reconcile on amount_refunded
    const charge2 = { id: 'evt_ch_2', type: 'charge.refunded', data: { object: { id: 'ch_1', object: 'charge', payment_intent: res.body.provider_payment_id, amount_refunded: 5500 } } };
    for (let i = 0; i < 2; i++) await asSystem(t.organizationId, (ctx) => processStripeEvent(ctx, { eventId: charge2.id, eventType: charge2.type, payload: charge2 }));
    const p2 = await t.owner.get(`/v1/payments/${res.body.id}`);
    expect(p2.body).toMatchObject({ status: 'refunded', refunded_amount: 5500 });
    expect((await t.owner.get(`/v1/transactions/${draft.id}`)).body.status).toBe('refunded');
  });

  it('marks failures, ignores unknown or mismatching events and never leaks the secret key', async () => {
    const { t, menu } = await posSetup();
    await openRegister(t.owner, t.shopId);
    const fake = fakeStripe();
    setPaymentProviderOverride(createStripeProvider({ secretKey: SK, fetchImpl: fake.fetchImpl }));
    const draft = await quickSale(t.owner, t.shopId, [{ type: 'service', menuId: menu.id }], { complete: false, method: 'card' });
    const card = (await t.owner.get(`/v1/transactions/${draft.id}`)).body.payments[0];
    await t.owner.delete(`/v1/transactions/${draft.id}/payments/${card.id}`);
    const started = await asSystem(t.organizationId, (ctx) => startOnlinePayment(ctx, { transactionId: draft.id, amount: 5500, idempotencyKey: key() }));

    const mismatch = { id: 'evt_mm', type: 'payment_intent.succeeded', data: { object: { id: started.providerPaymentId, object: 'payment_intent', amount_received: 100 } } };
    expect(await asSystem(t.organizationId, (ctx) => processStripeEvent(ctx, { eventId: mismatch.id, eventType: mismatch.type, payload: mismatch }))).toBe('ignored');
    const unknown = { id: 'evt_x', type: 'payment_intent.succeeded', data: { object: { id: 'pi_unknown', object: 'payment_intent', amount_received: 100 } } };
    expect(await asSystem(t.organizationId, (ctx) => processStripeEvent(ctx, { eventId: unknown.id, eventType: unknown.type, payload: unknown }))).toBe('ignored');
    expect(await asSystem(t.organizationId, (ctx) => processStripeEvent(ctx, { eventId: 'evt_y', eventType: 'customer.created', payload: {} }))).toBe('ignored');

    const failed = {
      id: 'evt_fail',
      type: 'payment_intent.payment_failed',
      data: { object: { id: started.providerPaymentId, object: 'payment_intent', last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' } } },
    };
    expect(await asSystem(t.organizationId, (ctx) => processStripeEvent(ctx, { eventId: failed.id, eventType: failed.type, payload: failed }))).toBe('processed');
    const p = await t.owner.get(`/v1/payments/${started.paymentId}`);
    expect(p.body).toMatchObject({ status: 'failed', failure_code: 'insufficient_funds' });
    // a late success for a failed payment is a no-op (final state)
    const late = { id: 'evt_late', type: 'payment_intent.succeeded', data: { object: { id: started.providerPaymentId, object: 'payment_intent', amount_received: 5500 } } };
    await asSystem(t.organizationId, (ctx) => processStripeEvent(ctx, { eventId: late.id, eventType: late.type, payload: late }));
    expect((await t.owner.get(`/v1/payments/${started.paymentId}`)).body.status).toBe('failed');

    // provider errors are mapped to external errors without the secret
    setPaymentProviderOverride(createStripeProvider({ secretKey: SK, fetchImpl: fakeStripe({ failWith: { status: 402, body: { error: { type: 'card_error', code: 'card_declined', message: `bad key ${SK}` } } } }).fetchImpl }));
    const err = await asSystem(t.organizationId, (ctx) => startOnlinePayment(ctx, { transactionId: draft.id, amount: 5500, idempotencyKey: key() })).catch((e) => e);
    expect(err).toMatchObject({ category: 'external', details: { provider: 'stripe', status: 402, code: 'card_declined', requestId: 'req_123' } });
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(SK);
    // nothing was stored for the failed attempt
    const rows = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('payments').select('id').where('transaction_id', '=', draft.id).where('provider', '=', 'stripe').execute());
    expect(rows).toHaveLength(1);
  });

  it('refundPayment on an offline payment needs no provider call', async () => {
    const { t, menu } = await posSetup();
    await openRegister(t.owner, t.shopId);
    const fake = fakeStripe();
    setPaymentProviderOverride(createStripeProvider({ secretKey: SK, fetchImpl: fake.fetchImpl }));
    const sale = await quickSale(t.owner, t.shopId, [{ type: 'service', menuId: menu.id }], { method: 'card' });
    const r = await asSystem(t.organizationId, (ctx) => refundPayment(ctx, { paymentId: sale.payments[0].id, amount: 500, idempotencyKey: 'offline-r1' }));
    expect(r).toMatchObject({ status: 'succeeded', provider_refund_id: null, amount: 500 });
    expect(fake.calls).toHaveLength(0);
  });

  it('encodes nested metadata', () => {
    expect(formEncode({ amount: 100, metadata: { a: 'x y', b: undefined }, skip: undefined })).toBe('amount=100&metadata%5Ba%5D=x+y');
  });
});
