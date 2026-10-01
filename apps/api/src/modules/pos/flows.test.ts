import { describe, expect, it } from 'vitest';
import { asSystem, createStaffUser } from '../../test/helpers.js';
import { book, createProduct, customerRow, grantPoints, key, openRegister, posSetup as setup, quickSale, setPosSettings, stockOf, year } from './test-utils.js';

describe('payments on a draft', () => {
  it('computes change, splits tender, replays idempotent payments and removes offline lines', async () => {
    const { t, menu } = await setup();
    await openRegister(t.owner, t.shopId);
    const custom = (await t.owner.post('/v1/payment-methods/custom', { shopId: t.shopId, name: '回数券' })).body;
    const d = (await t.owner.post('/v1/transactions', { shopId: t.shopId })).body;
    const put = await t.owner.put(`/v1/transactions/${d.id}/items`, { version: d.version, items: [{ type: 'service', menuId: menu.id }, { type: 'adjustment', name: '端数調整', unitPrice: -500 }] });
    expect(put.body.total).toBe(5000);

    const k1 = key();
    const card = await t.owner.post(`/v1/transactions/${d.id}/payments`, { method: 'card', amount: 2000, idempotencyKey: k1 });
    expect(card.status).toBe(201);
    const replay = await t.owner.post(`/v1/transactions/${d.id}/payments`, { method: 'card', amount: 2000, idempotencyKey: k1 });
    expect(replay.status).toBe(201);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.paymentId).toBe(card.body.paymentId);

    // tendered amount only allowed for cash; custom requires an active method
    expect((await t.owner.post(`/v1/transactions/${d.id}/payments`, { method: 'qr', amount: 100, tenderedAmount: 200, idempotencyKey: key() })).status).toBe(400);
    const noMethod = await t.owner.post(`/v1/transactions/${d.id}/payments`, { method: "custom", amount: 100, idempotencyKey: key() });
    expect(noMethod.status, JSON.stringify(noMethod.body)).toBe(400);
    const cu = await t.owner.post(`/v1/transactions/${d.id}/payments`, { method: 'custom', customMethodId: custom.id, amount: 1000, idempotencyKey: key() });
    expect(cu.status).toBe(201);

    // overpayment / insufficient tender
    const over = await t.owner.post(`/v1/transactions/${d.id}/payments`, { method: 'emoney', amount: 2001, idempotencyKey: key() });
    expect(over.body.error.code).toBe('AMOUNT_EXCEEDS_BALANCE');
    const short = await t.owner.post(`/v1/transactions/${d.id}/payments`, { method: 'cash', amount: 2000, tenderedAmount: 1000, idempotencyKey: key() });
    expect(short.body.error.code).toBe('INSUFFICIENT_TENDER');

    // remove the custom payment, then pay the rest in cash with change
    const rm = await t.owner.delete(`/v1/transactions/${d.id}/payments/${cu.body.paymentId}`);
    expect(rm.status).toBe(200);
    expect(rm.body.outstanding).toBe(3000);
    const cash = await t.owner.post(`/v1/transactions/${d.id}/payments`, { method: 'cash', tenderedAmount: 10000, idempotencyKey: key() });
    expect(cash.body.change).toBe(7000);
    expect((await t.owner.post(`/v1/transactions/${d.id}/payments`, { method: 'cash', idempotencyKey: key() })).body.error.code).toBe('NOTHING_TO_PAY');

    // lines cannot shrink below what was paid
    const shrink = await t.owner.put(`/v1/transactions/${d.id}/items`, { version: put.body.version, items: [{ type: 'service', name: '前髪カット', unitPrice: 1100 }] });
    expect(shrink.body.error.code).toBe('PAYMENTS_EXCEED_TOTAL');

    const done = await t.owner.post(`/v1/transactions/${d.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.payments.filter((p: any) => p.status === 'succeeded').map((p: any) => [p.method, p.amount])).toEqual([
      ['card', 2000],
      ['cash', 3000],
    ]);
    expect(done.body.change_total).toBe(7000);
    // completed offline payments cannot be removed anymore
    expect((await t.owner.delete(`/v1/transactions/${d.id}/payments/${card.body.paymentId}`)).status).toBe(422);
  });

  it('handles online card payments through the payment provider (mock) and blocks completion while pending', async () => {
    const { t, menu } = await setup();
    await openRegister(t.owner, t.shopId);
    const d = (await t.owner.post('/v1/transactions', { shopId: t.shopId })).body;
    await t.owner.put(`/v1/transactions/${d.id}/items`, { version: d.version, items: [{ type: 'service', menuId: menu.id }] });
    const online = await t.owner.post(`/v1/transactions/${d.id}/payments`, { method: 'card', online: true, idempotencyKey: key() });
    expect(online.status).toBe(201);
    const pay = online.body.transaction.payments[0];
    expect(pay).toMatchObject({ method: 'online', provider: 'mock', status: 'requires_action', amount: 5500 });
    expect(pay.client_secret).toBeTruthy();
    expect((await t.owner.post(`/v1/transactions/${d.id}/complete`)).body.error.code).toBe('PAYMENT_PENDING');
    // double-charge prevention: nothing left to pay while the online payment is pending
    expect((await t.owner.post(`/v1/transactions/${d.id}/payments`, { method: 'cash', idempotencyKey: key() })).body.error.code).toBe('NOTHING_TO_PAY');
    const settled = await t.owner.post(`/v1/payments/${pay.id}/mock-complete`, { success: true });
    expect(settled.body.status).toBe('succeeded');
    const done = await t.owner.post(`/v1/transactions/${d.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.paid_total).toBe(5500);

    // refund through the payments API is reflected on the transaction (event subscriber)
    const refund = await t.owner.post(`/v1/payments/${pay.id}/refund`, { amount: 1500, reason: '一部返金', idempotencyKey: key() });
    expect(refund.status).toBe(200);
    expect(refund.body.status).toBe('partially_refunded');
    const after = await t.owner.get(`/v1/transactions/${d.id}`);
    expect(after.body.status).toBe('partially_refunded');
    expect(after.body.refunded_total).toBe(1500);
  });

  it('requires an open register when configured', async () => {
    const { t, menu } = await setup();
    const draft = await quickSale(t.owner, t.shopId, [{ type: 'service', menuId: menu.id }], { complete: false });
    const res = await t.owner.post(`/v1/transactions/${draft.id}/complete`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('REGISTER_NOT_OPEN');
    await setPosSettings(t, { requireOpenRegister: false });
    const ok = await t.owner.post(`/v1/transactions/${draft.id}/complete`);
    expect(ok.status).toBe(200);
    expect(ok.body.register_session_id).toBeNull();
  });
});

describe('draft editing', () => {
  it('validates staff shares, applies mixed tax rates with % discount and per-line staff allocation', async () => {
    const { t, stylist, menu } = await setup();
    const assistant = await createStaffUser(t, 'stylist', { displayName: 'アシスタント' });
    const food = await createProduct(t, { name: 'ハーブティー', price: 1080, taxRateBp: 800, stock: 10 });
    const d = (await t.owner.post('/v1/transactions', { shopId: t.shopId, staffId: stylist.staffId })).body;
    const bad = await t.owner.put(`/v1/transactions/${d.id}/items`, {
      version: d.version,
      items: [{ type: 'service', menuId: menu.id, staff: [{ staffId: stylist.staffId, shareBp: 6000 }, { staffId: assistant.staffId, shareBp: 3000, role: 'assistant' }] }],
    });
    expect(bad.status).toBe(400);
    const put = await t.owner.put(`/v1/transactions/${d.id}/items`, {
      version: d.version,
      items: [
        { type: 'service', menuId: menu.id, staff: [{ staffId: stylist.staffId, shareBp: 7000 }, { staffId: assistant.staffId, shareBp: 3000, role: 'assistant' }] },
        { type: 'product', productId: food.id, quantity: 2 },
        { type: 'discount', percent: 10 },
      ],
    });
    expect(put.status).toBe(200);
    const b = put.body;
    // 5500 + 2160 = 7660, 10% = 766 → 6894
    expect(b.subtotal).toBe(7660);
    expect(b.discount_total).toBe(766);
    expect(b.total).toBe(6894);
    const [svcLine, foodLine, discLine] = b.items;
    expect(discLine).toMatchObject({ item_type: 'discount', amount: -766, unit_price: -766, net_amount: 0 });
    expect(svcLine.net_amount + foodLine.net_amount).toBe(6894);
    expect(b.tax_breakdown['1000'].taxable).toBe(svcLine.net_amount);
    expect(b.tax_breakdown['800'].taxable).toBe(foodLine.net_amount);
    expect(b.tax_total).toBe(b.tax_breakdown['1000'].tax + b.tax_breakdown['800'].tax);
    // staff allocation sums to the line's net
    expect(svcLine.staff.reduce((s: number, x: any) => s + x.allocated_amount, 0)).toBe(svcLine.net_amount);
    expect(svcLine.staff.find((x: any) => x.staff_id === assistant.staffId).role).toBe('assistant');
    // default staff for lines without allocations = transaction's main staff
    expect(foodLine.staff).toEqual([expect.objectContaining({ staff_id: stylist.staffId, share_bp: 10000, allocated_amount: foodLine.net_amount })]);
  });
});

describe('void', () => {
  it('reverses stock, points, coupon, appointment and payments', async () => {
    const { t, stylist, menu, customer } = await setup();
    const coupon = (await t.owner.post('/v1/coupons', { name: '1000円引', discountType: 'amount', discountValue: 1000 })).body;
    const product = await createProduct(t, { price: 2200, stock: 5 });
    await grantPoints(t, customer.id, 500);
    await openRegister(t.owner, t.shopId);
    const appt = await book(t, { staffId: stylist.staffId, customerId: customer.id, menuIds: [menu.id], couponId: coupon.id });
    const d = (await t.owner.post('/v1/transactions', { shopId: t.shopId, appointmentId: appt.id })).body;
    const items = [
      ...d.items
        .filter((i: any) => i.item_type !== 'coupon')
        .map((i: any) => ({ type: i.item_type, menuId: i.menu_id ?? undefined, unitPrice: i.unit_price, name: i.name, staff: i.staff.map((s: any) => ({ staffId: s.staff_id, shareBp: s.share_bp, isNominated: s.is_nominated })) })),
      { type: 'product', productId: product.id, quantity: 1 },
      { type: 'coupon', couponId: coupon.id },
    ];
    const put = await t.owner.put(`/v1/transactions/${d.id}/items`, { version: d.version, items });
    expect(put.body.total).toBe(5500 + 1100 + 2200 - 1000);
    await t.owner.post(`/v1/transactions/${d.id}/points`, { use: 500 });
    await t.owner.post(`/v1/transactions/${d.id}/payments`, { method: 'cash', tenderedAmount: 10000, idempotencyKey: key() });
    const done = await t.owner.post(`/v1/transactions/${d.id}/complete`);
    expect(done.status).toBe(200);
    expect(await stockOf(t, product.id)).toBe(4);
    expect((await customerRow(t, customer.id)).point_balance).toBe(500 - 500 + 73); // floor(7300 × 1%)

    // stylist cannot void
    const forbidden = await stylist.api.post(`/v1/transactions/${d.id}/void`, { reason: '誤登録' });
    expect(forbidden.status).toBe(403);

    const v = await t.owner.post(`/v1/transactions/${d.id}/void`, { reason: '誤登録' });
    expect(v.status).toBe(200);
    expect(v.body.status).toBe('voided');
    expect(v.body.void_reason).toBe('誤登録');
    expect(v.body.payments.every((p: any) => p.status === 'cancelled')).toBe(true);
    expect(await stockOf(t, product.id)).toBe(5);
    const c = await customerRow(t, customer.id);
    expect(c.point_balance).toBe(500);
    expect(c.visit_count).toBe(0);
    expect(c.total_sales).toBe(0);
    expect((await t.owner.get(`/v1/appointments/${appt.id}`)).body.status).toBe('in_service');
    const side = await asSystem(t.organizationId, async (ctx) => ({
      redemptions: await ctx.trx.selectFrom('coupon_redemptions').select('status').where('transaction_id', '=', d.id).execute(),
      events: await ctx.trx.selectFrom('domain_events').select('event_type').where('aggregate_id', '=', d.id).execute(),
    }));
    expect(side.redemptions).toEqual([{ status: 'released' }]);
    expect(side.events.map((e) => e.event_type)).toContain('transaction.voided');

    // number stays (gapless); a new checkout for the appointment is possible again
    expect(v.body.transaction_number).toBe(`${year}-000001`);
    const again = await t.owner.post('/v1/transactions', { shopId: t.shopId, appointmentId: appt.id });
    expect(again.status).toBe(201);
    // void is idempotent
    expect((await t.owner.post(`/v1/transactions/${d.id}/void`, { reason: '誤登録' })).body.status).toBe('voided');
  });

  it('is refused after the business day once the register is closed (refund instead)', async () => {
    const { t, menu } = await setup();
    const reg = await openRegister(t.owner, t.shopId, 0);
    const done = await quickSale(t.owner, t.shopId, [{ type: 'service', menuId: menu.id }]);
    await t.owner.post(`/v1/register-sessions/${reg.id}/close`, { countedCash: 5500 });
    await asSystem(t.organizationId, (ctx) => ctx.trx.updateTable('transactions').set({ completed_at: new Date(Date.now() - 2 * 86_400_000) }).where('id', '=', done.id).execute());
    const v = await t.owner.post(`/v1/transactions/${done.id}/void`, { reason: '翌日取消' });
    expect(v.status).toBe(422);
    expect(v.body.error.code).toBe('VOID_NOT_ALLOWED');
  });

  it('discards a draft and frees the appointment', async () => {
    const { t, stylist, menu, customer } = await setup();
    const appt = await book(t, { staffId: stylist.staffId, customerId: customer.id, menuIds: [menu.id] });
    const d = (await t.owner.post('/v1/transactions', { shopId: t.shopId, appointmentId: appt.id })).body;
    await t.owner.post(`/v1/transactions/${d.id}/payments`, { method: 'card', amount: 1000, idempotencyKey: key() });
    const v = await stylist.api.post(`/v1/transactions/${d.id}/void`, { reason: '入力やり直し' });
    expect(v.status).toBe(200);
    expect(v.body.status).toBe('voided');
    expect(v.body.transaction_number).toBeNull();
    expect(v.body.payments[0].status).toBe('cancelled');
    expect((await t.owner.post('/v1/transactions', { shopId: t.shopId, appointmentId: appt.id })).status).toBe(201);
  });
});

describe('refunds', () => {
  it('refunds partially then fully, reverting points proportionally and restocking returned items', async () => {
    const { t, menu, customer } = await setup();
    const product = await createProduct(t, { price: 4400, stock: 3 });
    await openRegister(t.owner, t.shopId);
    const done = await quickSale(
      t.owner,
      t.shopId,
      [
        { type: 'service', menuId: menu.id },
        { type: 'product', productId: product.id, quantity: 1 },
      ],
      { customerId: customer.id },
    );
    expect(done.total).toBe(9900);
    expect(done.point_earned).toBe(99);
    expect(await stockOf(t, product.id)).toBe(2);

    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.post(`/v1/transactions/${done.id}/refunds`, { amount: 100, reason: 'x', idempotencyKey: key() })).status).toBe(403);
    const tooMuch = await t.owner.post(`/v1/transactions/${done.id}/refunds`, { amount: 9901, reason: '返品', idempotencyKey: key() });
    expect(tooMuch.body.error.code).toBe('REFUND_EXCEEDS_TOTAL');

    const k = key('refund');
    const itemId = done.items.find((i: any) => i.item_type === 'product').id;
    const r1 = await t.owner.post(`/v1/transactions/${done.id}/refunds`, { amount: 4400, reason: '商品返品', restockItems: [{ itemId, quantity: 1 }], idempotencyKey: k });
    expect(r1.status).toBe(200);
    expect(r1.body.status).toBe('partially_refunded');
    expect(r1.body.refunded_total).toBe(4400);
    expect(await stockOf(t, product.id)).toBe(3);
    // replay with the same key does not refund twice
    const r1b = await t.owner.post(`/v1/transactions/${done.id}/refunds`, { amount: 4400, reason: '商品返品', restockItems: [{ itemId, quantity: 1 }], idempotencyKey: k });
    expect(r1b.body.refunded_total).toBe(4400);
    expect(await stockOf(t, product.id)).toBe(3);
    let c = await customerRow(t, customer.id);
    expect(c.point_balance).toBe(99 - 44); // floor(99 × 4400/9900) = 44 reverted
    expect(c.total_sales).toBe(5500);

    // cannot return more than sold
    const over = await t.owner.post(`/v1/transactions/${done.id}/refunds`, { amount: 100, reason: '返品', restockItems: [{ itemId, quantity: 1 }], idempotencyKey: key() });
    expect(over.body.error.code).toBe('RETURN_EXCEEDS_QUANTITY');

    const r2 = await t.owner.post(`/v1/transactions/${done.id}/refunds`, { amount: 5500, reason: '施術やり直し不可', idempotencyKey: key() });
    expect(r2.body.status).toBe('refunded');
    expect(r2.body.refunded_total).toBe(9900);
    c = await customerRow(t, customer.id);
    expect(c.point_balance).toBe(0);
    expect(c.total_sales).toBe(0);
    const events = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('domain_events').select(['event_type', 'payload']).where('aggregate_id', '=', done.id).where('event_type', '=', 'transaction.refunded').orderBy('created_at').execute(),
    );
    expect(events.map((e) => (e.payload as any).refundedAmount)).toEqual([4400, 5500]);
    expect((await t.owner.post(`/v1/transactions/${done.id}/refunds`, { amount: 1, reason: 'x', idempotencyKey: key() })).body.error.code).toBe('NOT_REFUNDABLE');
  });

  it('returns refunded point payments to the customer', async () => {
    const { t, menu, customer } = await setup();
    await setPosSettings(t, { requireOpenRegister: false, pointRateBp: 0 });
    await grantPoints(t, customer.id, 1000);
    const d = (await t.owner.post('/v1/transactions', { shopId: t.shopId, customerId: customer.id })).body;
    await t.owner.put(`/v1/transactions/${d.id}/items`, { version: d.version, items: [{ type: 'service', menuId: menu.id }] });
    await t.owner.post(`/v1/transactions/${d.id}/points`, { use: 1000 });
    await t.owner.post(`/v1/transactions/${d.id}/payments`, { method: 'card', idempotencyKey: key() });
    expect((await t.owner.post(`/v1/transactions/${d.id}/complete`)).status).toBe(200);
    expect((await customerRow(t, customer.id)).point_balance).toBe(0);
    const pointPayment = (await t.owner.get(`/v1/transactions/${d.id}`)).body.payments.find((p: any) => p.method === 'point');
    const r = await t.owner.post(`/v1/transactions/${d.id}/refunds`, { amount: 600, reason: 'ポイント返還', paymentId: pointPayment.id, idempotencyKey: key() });
    expect(r.status).toBe(200);
    expect((await customerRow(t, customer.id)).point_balance).toBe(600);
  });
});
