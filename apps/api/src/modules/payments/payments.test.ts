import { describe, expect, it } from 'vitest';
import { asSystem, createStaffUser, createTenant } from '../../test/helpers.js';
import { key, openRegister, posSetup, quickSale } from '../pos/test-utils.js';
import { refundPayment, startOnlinePayment } from './api.js';

async function draftWithTotal(total = 5500) {
  const s = await posSetup();
  await openRegister(s.t.owner, s.t.shopId);
  const d = await quickSale(s.t.owner, s.t.shopId, [{ type: 'service', name: 'カット', unitPrice: total }], { complete: false, method: 'card' }).then(async (x) => {
    // quickSale paid it by card: remove that line so the draft is unpaid again
    const pay = (await s.t.owner.get(`/v1/transactions/${x.id}`)).body.payments[0];
    await s.t.owner.delete(`/v1/transactions/${x.id}/payments/${pay.id}`);
    return (await s.t.owner.get(`/v1/transactions/${x.id}`)).body;
  });
  return { ...s, draft: d };
}

describe('POST /payments (online payments)', () => {
  it('starts an online payment for the outstanding balance, idempotently, without double charging', async () => {
    const { t, draft } = await draftWithTotal(5500);
    const k = key('pay');
    const r1 = await t.owner.post('/v1/payments', { transactionId: draft.id, idempotencyKey: k });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ transaction_id: draft.id, method: 'online', provider: 'mock', amount: 5500, status: 'requires_action', replayed: false });
    expect(r1.body.client_secret).toMatch(/^mock_pi_/);
    // same key (body) → same payment
    const r2 = await t.owner.post('/v1/payments', { transactionId: draft.id, idempotencyKey: k });
    expect(r2.body.id).toBe(r1.body.id);
    expect(r2.body.replayed).toBe(true);
    // header key works too (route-level idempotency)
    const h = { 'idempotency-key': key('hdr') };
    const r3 = await t.owner.post('/v1/payments', { transactionId: draft.id, amount: 1 }, h);
    expect(r3.status).toBe(422); // balance is fully held by the pending payment
    expect(r3.body.error.code).toBe('AMOUNT_EXCEEDS_BALANCE');
    // key reuse with a different amount is rejected
    const reuse = await t.owner.post('/v1/payments', { transactionId: draft.id, amount: 100, idempotencyKey: k });
    expect(reuse.status).toBe(422);
    expect(reuse.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // missing key
    expect((await t.owner.post('/v1/payments', { transactionId: draft.id })).status).toBe(400);
    // exactly one of transactionId / orderId
    expect((await t.owner.post('/v1/payments', { idempotencyKey: key() })).status).toBe(400);

    const got = await t.owner.get(`/v1/payments/${r1.body.id}`);
    expect(got.body).toMatchObject({ id: r1.body.id, status: 'requires_action', refunds: [] });
    const failed = await t.owner.post(`/v1/payments/${r1.body.id}/mock-complete`, { success: false, failureCode: 'card_declined' });
    expect(failed.body).toMatchObject({ status: 'failed', failure_code: 'card_declined', client_secret: null });
    // failed payments release the balance; settle is final
    expect((await t.owner.post(`/v1/payments/${r1.body.id}/mock-complete`, { success: true })).body.status).toBe('failed');
    const retry = await t.owner.post('/v1/payments', { transactionId: draft.id, idempotencyKey: key('retry') });
    expect(retry.status).toBe(201);
    const ok = await t.owner.post(`/v1/payments/${retry.body.id}/mock-complete`);
    expect(ok.body.status).toBe('succeeded');
    const events = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('domain_events').select('event_type').where('aggregate_type', '=', 'payment').orderBy('created_at').execute());
    expect(events.map((e) => e.event_type)).toEqual(['payment.failed', 'payment.succeeded']);
    const tx = await t.owner.get(`/v1/transactions/${draft.id}`);
    expect(tx.body.paid_total).toBe(5500);
    expect((await t.owner.post(`/v1/transactions/${draft.id}/complete`)).status).toBe(200);
    // no more payments for a completed transaction
    expect((await t.owner.post('/v1/payments', { transactionId: draft.id, idempotencyKey: key() })).body.error.code).toBe('TRANSACTION_NOT_DRAFT');
  });

  it('refunds with permission checks, idempotency and amount limits', async () => {
    const { t, stylist, draft } = await draftWithTotal(8000);
    const p = (await t.owner.post('/v1/payments', { transactionId: draft.id, idempotencyKey: key() })).body;
    // not refundable before success
    expect((await t.owner.post(`/v1/payments/${p.id}/refund`, { idempotencyKey: key() })).body.error.code).toBe('PAYMENT_NOT_REFUNDABLE');
    await t.owner.post(`/v1/payments/${p.id}/mock-complete`);
    await t.owner.post(`/v1/transactions/${draft.id}/complete`);

    expect((await stylist.api.post(`/v1/payments/${p.id}/refund`, { amount: 100, idempotencyKey: key() })).status).toBe(403);
    const k = key('rf');
    const r1 = await t.owner.post(`/v1/payments/${p.id}/refund`, { amount: 3000, reason: '一部返金', idempotencyKey: k });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ status: 'partially_refunded', refunded_amount: 3000 });
    expect(r1.body.refunds).toHaveLength(1);
    const r1b = await t.owner.post(`/v1/payments/${p.id}/refund`, { amount: 3000, reason: '一部返金', idempotencyKey: k });
    expect(r1b.body.refunded_amount).toBe(3000);
    expect(r1b.body.refunds).toHaveLength(1);
    const over = await t.owner.post(`/v1/payments/${p.id}/refund`, { amount: 5001, idempotencyKey: key() });
    expect(over.body.error.code).toBe('REFUND_EXCEEDS_PAYMENT');
    const rest = await t.owner.post(`/v1/payments/${p.id}/refund`, { idempotencyKey: key() }); // defaults to remaining
    expect(rest.body).toMatchObject({ status: 'refunded', refunded_amount: 8000 });
    const tx = await t.owner.get(`/v1/transactions/${draft.id}`);
    expect(tx.body).toMatchObject({ status: 'refunded', refunded_total: 8000 });
  });

  it('enforces the one-target linkage and balance in the public contract', async () => {
    const { t, draft } = await draftWithTotal(3000);
    await asSystem(t.organizationId, async (ctx) => {
      await expect(startOnlinePayment(ctx, { amount: 100, idempotencyKey: key() })).rejects.toMatchObject({ category: 'validation' });
      await expect(startOnlinePayment(ctx, { transactionId: draft.id, amount: 3001, idempotencyKey: key() })).rejects.toMatchObject({ code: 'AMOUNT_EXCEEDS_BALANCE' });
      const a = await startOnlinePayment(ctx, { transactionId: draft.id, amount: 1000, idempotencyKey: 'contract-1' });
      const b = await startOnlinePayment(ctx, { transactionId: draft.id, amount: 2000, idempotencyKey: 'contract-2' });
      expect(a.paymentId).not.toBe(b.paymentId);
      expect(a.providerPaymentId).not.toBe(b.providerPaymentId);
      await expect(startOnlinePayment(ctx, { transactionId: draft.id, amount: 1, idempotencyKey: 'contract-3' })).rejects.toMatchObject({ code: 'AMOUNT_EXCEEDS_BALANCE' });
      const replay = await startOnlinePayment(ctx, { transactionId: draft.id, amount: 1000, idempotencyKey: 'contract-1' });
      expect(replay).toMatchObject({ paymentId: a.paymentId, replayed: true });
      await expect(refundPayment(ctx, { paymentId: a.paymentId, amount: 100, idempotencyKey: 'r-1' })).rejects.toMatchObject({ code: 'PAYMENT_NOT_REFUNDABLE' });
    });
  });

  it('pays EC orders (order.manage) with balance checks and emits payment events with orderId', async () => {
    const { t, stylist } = await posSetup();
    const order = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.insertInto('orders').values({ organization_id: t.organizationId, order_number: `EC-${key()}`, subtotal: 4400, total: 4400 }).returning('id').executeTakeFirstOrThrow(),
    );
    expect((await stylist.api.post('/v1/payments', { orderId: order.id, idempotencyKey: key() })).status).toBe(403);
    const p = await t.owner.post('/v1/payments', { orderId: order.id, idempotencyKey: key() });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ order_id: order.id, transaction_id: null, amount: 4400 });
    expect((await t.owner.post('/v1/payments', { orderId: order.id, idempotencyKey: key() })).body.error.code).toBe('NOTHING_TO_PAY');
    await t.owner.post(`/v1/payments/${p.body.id}/mock-complete`);
    const ev = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('domain_events').select('payload').where('aggregate_id', '=', p.body.id).where('event_type', '=', 'payment.succeeded').executeTakeFirstOrThrow());
    expect(ev.payload).toEqual({ paymentId: p.body.id, transactionId: null, orderId: order.id, amount: 4400 });
  });

  it('isolates payments between tenants and shops', async () => {
    const { t, draft } = await draftWithTotal(1000);
    const p = (await t.owner.post('/v1/payments', { transactionId: draft.id, idempotencyKey: key() })).body;
    const other = await createTenant('別法人');
    expect((await other.owner.get(`/v1/payments/${p.id}`)).status).toBe(404);
    expect((await other.owner.post(`/v1/payments/${p.id}/mock-complete`)).status).toBe(404);
    expect((await other.owner.post('/v1/payments', { transactionId: draft.id, idempotencyKey: key() })).status).toBe(404);
    const assistant = await createStaffUser(t, 'assistant');
    expect((await assistant.api.post('/v1/payments', { transactionId: draft.id, idempotencyKey: key() })).status).toBe(403);
  });
});

describe('custom payment methods (店舗独自決済)', () => {
  it('supports CRUD and deactivates methods already used', async () => {
    const { t, stylist } = await posSetup();
    expect((await stylist.api.post('/v1/payment-methods/custom', { shopId: t.shopId, name: '商品券' })).status).toBe(403);
    const shopLevel = await t.owner.post('/v1/payment-methods/custom', { shopId: t.shopId, name: '商品券' });
    expect(shopLevel.status).toBe(201);
    const orgLevel = (await t.owner.post('/v1/payment-methods/custom', { name: '回数券', countsAsSales: false })).body;
    expect(orgLevel.counts_as_sales).toBe(false);
    const list = await stylist.api.get('/v1/payment-methods/custom', { shopId: t.shopId });
    expect(list.body.map((m: any) => m.name).sort()).toEqual(['商品券', '回数券'].sort());
    const upd = await t.owner.patch(`/v1/payment-methods/custom/${shopLevel.body.id}`, { name: 'ギフト券' });
    expect(upd.body.name).toBe('ギフト券');

    // use the org-level one, then delete → deactivated
    await openRegister(t.owner, t.shopId);
    const d = await quickSale(t.owner, t.shopId, [{ type: 'service', name: 'カット', unitPrice: 3000 }], { complete: false, method: 'cash' });
    const pay = (await t.owner.get(`/v1/transactions/${d.id}`)).body.payments[0];
    await t.owner.delete(`/v1/transactions/${d.id}/payments/${pay.id}`);
    const used = await t.owner.post(`/v1/transactions/${d.id}/payments`, { method: 'custom', customMethodId: orgLevel.id, idempotencyKey: key() });
    expect(used.status).toBe(201);
    expect(used.body.transaction.payments.find((p: any) => p.status === 'succeeded').custom_method_name).toBe('回数券');
    const del = await t.owner.delete(`/v1/payment-methods/custom/${orgLevel.id}`);
    expect(del.body).toEqual({ deactivated: true });
    const del2 = await t.owner.delete(`/v1/payment-methods/custom/${shopLevel.body.id}`);
    expect(del2.body).toEqual({ deactivated: false });
    const active = await t.owner.get('/v1/payment-methods/custom');
    expect(active.body).toHaveLength(0);
    const all = await t.owner.get('/v1/payment-methods/custom', { includeInactive: 'true' });
    expect(all.body.map((m: any) => m.id)).toEqual([orgLevel.id]);
    // inactive methods cannot be used
    const d2 = await quickSale(t.owner, t.shopId, [{ type: 'service', name: 'カット', unitPrice: 1000 }], { complete: false, method: 'cash' });
    const p2 = (await t.owner.get(`/v1/transactions/${d2.id}`)).body.payments[0];
    await t.owner.delete(`/v1/transactions/${d2.id}/payments/${p2.id}`);
    expect((await t.owner.post(`/v1/transactions/${d2.id}/payments`, { method: 'custom', customMethodId: orgLevel.id, idempotencyKey: key() })).status).toBe(400);
  });
});
