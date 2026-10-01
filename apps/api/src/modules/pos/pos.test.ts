import { describe, expect, it } from 'vitest';
import { asSystem } from '../../test/helpers.js';
import { book, createProduct, customerRow, grantPoints, key, openRegister, posSetup as setup, stockOf, year } from './test-utils.js';

describe('checkout from an appointment', () => {
  it('prefills lines, takes points + cash, completes with stock/coupon/points/appointment/stats/event', async () => {
    const { t, stylist, menu, customer } = await setup();
    const coupon = (await t.owner.post('/v1/coupons', { name: '初回500円引', discountType: 'amount', discountValue: 500, applicableMenuIds: [menu.id] })).body;
    const product = await createProduct(t, { name: 'トリートメント', price: 3300, stock: 1 });
    await grantPoints(t, customer.id, 300);
    await openRegister(t.owner, t.shopId);
    const appt = await book(t, { staffId: stylist.staffId, customerId: customer.id, menuIds: [menu.id], couponId: coupon.id });

    const created = await t.owner.post('/v1/transactions', { shopId: t.shopId, appointmentId: appt.id });
    expect(created.status).toBe(201);
    const draft = created.body;
    expect(draft.status).toBe('draft');
    expect(draft.staff_id).toBe(stylist.staffId);
    expect(draft.is_nominated).toBe(true);
    expect(draft.items.map((i: any) => [i.item_type, i.amount])).toEqual([
      ['service', 5500],
      ['nomination_fee', 1100],
      ['coupon', -500],
    ]);
    expect(draft.total).toBe(6100);
    const svc = draft.items[0];
    expect(svc.net_amount).toBe(5000); // coupon applies to the service line only
    expect(svc.staff).toEqual([expect.objectContaining({ staff_id: stylist.staffId, share_bp: 10000, is_nominated: true, allocated_amount: 5000 })]);
    expect(draft.items[1].staff[0]).toMatchObject({ staff_id: stylist.staffId, allocated_amount: 1100 });

    // only one active transaction per appointment
    const dup = await t.owner.post('/v1/transactions', { shopId: t.shopId, appointmentId: appt.id });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('TRANSACTION_EXISTS');

    // add a product (stock 1, selling 2) keeping the prefilled lines
    const put = await t.owner.put(`/v1/transactions/${draft.id}/items`, {
      version: draft.version,
      items: [
        { type: 'service', menuId: menu.id, staff: [{ staffId: stylist.staffId, shareBp: 10000, isNominated: true }] },
        { type: 'nomination_fee', staff: [{ staffId: stylist.staffId, shareBp: 10000, isNominated: true }] },
        { type: 'coupon', couponId: coupon.id },
        { type: 'product', productId: product.id, quantity: 2 },
      ],
    });
    expect(put.status).toBe(200);
    expect(put.body.total).toBe(5500 + 1100 + 6600 - 500);
    expect(put.body.tax_total).toBe(1154); // 12700 × 10/110 = 1154.5 → floor
    expect(put.body.tax_breakdown).toEqual({ '1000': { taxable: 12700, tax: 1154 } });
    expect(put.body.items.reduce((s: number, i: any) => s + i.tax_amount, 0)).toBe(1154);

    // stale version
    const stale = await t.owner.put(`/v1/transactions/${draft.id}/items`, { version: draft.version, items: [] });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');

    // points: cannot exceed balance
    expect((await t.owner.post(`/v1/transactions/${draft.id}/points`, { use: 301 })).body.error.code).toBe('INSUFFICIENT_POINTS');
    const pts = await t.owner.post(`/v1/transactions/${draft.id}/points`, { use: 300 });
    expect(pts.status).toBe(200);
    expect(pts.body.point_used).toBe(300);
    expect(pts.body.outstanding).toBe(12400);

    // incomplete payment
    const early = await t.owner.post(`/v1/transactions/${draft.id}/complete`);
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('PAYMENT_INCOMPLETE');

    const pay = await t.owner.post(`/v1/transactions/${draft.id}/payments`, { method: 'cash', tenderedAmount: 20000, idempotencyKey: key() });
    expect(pay.status).toBe(201);
    expect(pay.body.change).toBe(7600);
    expect(pay.body.transaction.outstanding).toBe(0);

    const done = await t.owner.post(`/v1/transactions/${draft.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
    expect(done.body.transaction_number).toBe(`${year}-000001`);
    expect(done.body.paid_total).toBe(12700);
    expect(done.body.change_total).toBe(7600);
    expect(done.body.point_used).toBe(300);
    expect(done.body.point_earned).toBe(124); // floor(12400 × 1%)
    expect(done.body.is_new_customer).toBe(true);
    expect(done.body.register_session_id).toBeTruthy();
    expect(done.body.stockWarnings).toEqual([expect.objectContaining({ productId: product.id, quantity: -1 })]);

    // idempotent completion
    const again = await t.owner.post(`/v1/transactions/${draft.id}/complete`);
    expect(again.status).toBe(200);
    expect(again.body.transaction_number).toBe(`${year}-000001`);
    expect(again.body.replayed).toBe(true);

    expect(await stockOf(t, product.id)).toBe(-1);
    const c = await customerRow(t, customer.id);
    expect(c.point_balance).toBe(124);
    expect(c.visit_count).toBe(1);
    expect(c.total_sales).toBe(12700);
    const appointment = await t.owner.get(`/v1/appointments/${appt.id}`);
    expect(appointment.body.status).toBe('completed');

    const side = await asSystem(t.organizationId, async (ctx) => ({
      events: await ctx.trx.selectFrom('domain_events').select(['event_type', 'payload']).where('aggregate_id', '=', draft.id).execute(),
      redemptions: await ctx.trx.selectFrom('coupon_redemptions').select(['status', 'transaction_id']).where('appointment_id', '=', appt.id).execute(),
      ledger: await ctx.trx.selectFrom('point_ledger').select(['reason', 'delta', 'expires_at']).where('transaction_id', '=', draft.id).orderBy('created_at').execute(),
      moves: await ctx.trx.selectFrom('stock_movements').select(['reason', 'delta']).where('transaction_id', '=', draft.id).execute(),
      visited: await ctx.trx.selectFrom('customer_shop_relations').select('id').where('customer_id', '=', customer.id).where('relation_type', '=', 'visited').execute(),
    }));
    const completedEvents = side.events.filter((e) => e.event_type === 'transaction.completed');
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]!.payload).toMatchObject({ transactionId: draft.id, shopId: t.shopId, customerId: customer.id, appointmentId: appt.id, total: 12700 });
    expect(side.redemptions).toEqual([{ status: 'redeemed', transaction_id: draft.id }]);
    expect(side.ledger.map((l) => [l.reason, l.delta])).toEqual([
      ['redeem', -300],
      ['earn', 124],
    ]);
    expect(side.ledger[1]!.expires_at).toBeTruthy();
    expect(side.moves).toEqual([{ reason: 'sale', delta: -2 }]);
    expect(side.visited).toHaveLength(1);

    // completed transactions are immutable
    const edit = await t.owner.put(`/v1/transactions/${draft.id}/items`, { version: done.body.version, items: [] });
    expect(edit.status).toBe(422);
    expect(edit.body.error.code).toBe('TRANSACTION_NOT_DRAFT');
  });

  it('skips an appointment coupon that is no longer valid with a warning', async () => {
    const { t, stylist, menu, customer } = await setup();
    const coupon = (await t.owner.post('/v1/coupons', { name: '期間限定', discountType: 'percent', discountValue: 10 })).body;
    const appt = await book(t, { staffId: stylist.staffId, customerId: customer.id, menuIds: [menu.id], couponId: coupon.id });
    await t.owner.patch(`/v1/coupons/${coupon.id}`, { status: 'inactive' });
    const created = await t.owner.post('/v1/transactions', { shopId: t.shopId, appointmentId: appt.id });
    expect(created.status).toBe(201);
    expect(created.body.items.map((i: any) => i.item_type)).toEqual(['service', 'nomination_fee']);
    expect(created.body.warnings[0]).toContain('期間限定');
  });
});

