import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { settleOnlinePayment } from '../payments/api.js';
import { asSystem, createCustomer, createStaffUser, createTenant, customerApi, makeJobsDue, runJobs, shopSlug, type Tenant } from '../../test/helpers.js';
import { computeTotals } from './orders.js';

const address = { postalCode: '1500001', prefecture: '東京都', city: '渋谷区神宮前', line1: '1-2-3', line2: 'サロンビル4F', name: '購入 花子', phone: '090-1234-5678' };

async function setup() {
  const t = await createTenant();
  const slug = await shopSlug(t);
  await t.owner.patch('/v1/organization', { settings: { commerce: { shippingFee: 880, freeShippingThreshold: 10000 } } });
  const shampoo = (await t.owner.post('/v1/products', { name: 'シャンプー', price: 3300, isOnline: true })).body;
  const tea = (await t.owner.post('/v1/products', { name: 'ハーブティー', price: 1080, taxRateBp: 800, isOnline: true })).body;
  await t.owner.post(`/v1/products/${shampoo.id}/stock-adjustments`, { shopId: null, delta: 10, reason: 'receive' });
  await t.owner.post(`/v1/products/${tea.id}/stock-adjustments`, { shopId: null, delta: 5, reason: 'receive' });
  const customer = await createCustomer(t, { email: 'buyer@example.com' });
  const shopper = await customerApi(t, customer.id);
  return { t, slug, shampoo, tea, customer, shopper };
}

async function ecStock(t: Tenant, productId: string) {
  const s = (await t.owner.get(`/v1/products/${productId}/stock`)).body.locations.find((l: { shop_id: string | null }) => l.shop_id === null);
  return s?.quantity ?? 0;
}

function settle(t: Tenant, paymentId: string, success: boolean) {
  return asSystem(t.organizationId, (ctx) => settleOnlinePayment(ctx, paymentId, success ? { success } : { success, failureCode: 'card_declined', failureReason: 'カードが拒否されました' }));
}

async function placeOrder(env: Awaited<ReturnType<typeof setup>>, items: { productId: string; quantity: number }[], extra: Record<string, unknown> = {}) {
  const res = await env.shopper.post('/v1/public/orders', { shopSlug: env.slug, items, shippingAddress: address, idempotencyKey: randomUUID(), ...extra });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body as { order: { id: string; total: number; status: string; orderNumber: string }; payment: { paymentId: string; clientSecret: string } };
}

describe('order totals', () => {
  it('computes 内税 per tax rate including shipping and allocates line tax', () => {
    const r = computeTotals(
      [
        { productId: 'a', name: 'A', unitPrice: 3300, quantity: 2, taxRateBp: 1000, amount: 6600, stockManaged: true },
        { productId: 'b', name: 'B', unitPrice: 1080, quantity: 1, taxRateBp: 800, amount: 1080, stockManaged: true },
      ],
      880,
      1000,
    );
    expect(r.subtotal).toBe(7680);
    expect(r.total).toBe(8560);
    expect(r.breakdown).toEqual({ '1000': { taxable: 7480, tax: 680 }, '800': { taxable: 1080, tax: 80 } });
    expect(r.taxTotal).toBe(760);
    expect(r.lines.map((l) => l.taxAmount)).toEqual([600, 80]);
  });
});

describe('EC orders', () => {
  it('create → payment succeeded → paid → ship → deliver (with stock reservation, idempotency and attribution)', async () => {
    const env = await setup();
    const { t, shopper, shampoo, tea, customer } = env;
    const stylist = await createStaffUser(t, 'stylist', { displayName: '紹介スタイリスト' });
    const link = (await t.owner.post('/v1/referral-links', { name: 'EC紹介', staffId: stylist.staffId, target: 'product', targetId: shampoo.id })).body;

    const body = { shopSlug: env.slug, items: [{ productId: shampoo.id, quantity: 1 }, { productId: tea.id, quantity: 1 }, { productId: shampoo.id, quantity: 1 }], shippingAddress: address, referralCode: link.code.toLowerCase(), idempotencyKey: 'order-key-0001' };
    const res = await shopper.post('/v1/public/orders', body);
    expect(res.status).toBe(201);
    const { order, payment } = res.body;
    expect(order).toMatchObject({ status: 'pending', subtotal: 7680, shippingFee: 880, taxTotal: 760, total: 8560, paymentFailed: false });
    expect(order.orderNumber).toMatch(/^EC\d{4}-000001$/);
    expect(order.items).toEqual([
      expect.objectContaining({ productId: shampoo.id, quantity: 2, unitPrice: 3300, amount: 6600 }),
      expect.objectContaining({ productId: tea.id, quantity: 1, amount: 1080, taxRateBp: 800 }),
    ]);
    expect(order.shippingAddress.postalCode).toBe('150-0001');
    expect(payment.clientSecret).toBeTruthy();
    expect(await ecStock(t, shampoo.id)).toBe(8);
    expect(await ecStock(t, tea.id)).toBe(4);

    // idempotent replay returns the same order/payment and reserves nothing more
    const replay = await shopper.post('/v1/public/orders', body);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.order.id).toBe(order.id);
    expect(replay.body.payment.paymentId).toBe(payment.paymentId);
    expect(await ecStock(t, shampoo.id)).toBe(8);

    await settle(t, payment.paymentId, true);
    const paid = (await t.owner.get(`/v1/orders/${order.id}`)).body;
    expect(paid).toMatchObject({ status: 'paid', paid_payment_id: payment.paymentId, attributed_staff_id: stylist.staffId, referral_link_id: link.id });
    expect(paid.attributed_staff.display_name).toBe('紹介スタイリスト');
    expect(paid.payments).toEqual([expect.objectContaining({ status: 'succeeded', amount: 8560 })]);
    const jobs = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('jobs').select('state').where('dedupe_key', '=', `order-expire:${order.id}`).execute());
    expect(jobs.map((j) => j.state)).toEqual(['cancelled']);
    const events = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('domain_events').select(['event_type', 'payload']).where('aggregate_id', '=', order.id).execute());
    expect(events.map((e) => e.event_type)).toContain('order.paid');
    const stats = (await t.owner.get(`/v1/referral-links/${link.id}/stats`)).body;
    expect(stats).toMatchObject({ purchases: 1, purchaseRevenue: 8560 });

    // ship / deliver
    expect((await t.owner.post(`/v1/orders/${order.id}/deliver`, {})).status).toBe(422);
    const shipped = await t.owner.post(`/v1/orders/${order.id}/ship`, { carrier: 'ヤマト運輸', trackingNumber: '1234-5678-9012' });
    expect(shipped.status).toBe(200);
    expect(shipped.body).toMatchObject({ status: 'shipped', carrier: 'ヤマト運輸', tracking_number: '1234-5678-9012' });
    const delivered = await t.owner.post(`/v1/orders/${order.id}/deliver`, {});
    expect(delivered.body.status).toBe('delivered');
    expect((await t.owner.post(`/v1/orders/${order.id}/cancel`, { reason: '誤注文' })).body.error.code).toBe('ORDER_ALREADY_SHIPPED');

    const messages = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('messages').select(['category', 'payload', 'dedupe_key']).where('customer_id', '=', customer.id).execute());
    const keys = messages.map((m) => (m.payload as { templateKey: string }).templateKey);
    expect(keys).toEqual(expect.arrayContaining(['order_paid', 'order_shipped']));
    expect(messages.every((m) => m.category === 'transactional')).toBe(true);

    // customer views
    const mine = await shopper.get('/v1/public/me/orders');
    expect(mine.body.map((o: { id: string }) => o.id)).toEqual([order.id]);
    expect(mine.body[0]).toMatchObject({ status: 'delivered', trackingNumber: '1234-5678-9012' });
    expect((await shopper.get(`/v1/public/me/orders/${order.id}`)).body.status).toBe('delivered');
    const stranger = await customerApi(t, (await createCustomer(t)).id);
    expect((await stranger.get(`/v1/public/me/orders/${order.id}`)).status).toBe(404);

    // staff list filters
    expect((await t.owner.get('/v1/orders', { status: 'delivered' })).body.items.map((o: { id: string }) => o.id)).toEqual([order.id]);
    expect((await t.owner.get('/v1/orders', { status: 'pending' })).body.items).toHaveLength(0);
    expect((await t.owner.get('/v1/orders', { customerId: customer.id })).body.items[0].customer_name).toBeTruthy();
  });

  it('cancels a paid order with refund and restock', async () => {
    const env = await setup();
    const { t, shampoo } = env;
    const { order, payment } = await placeOrder(env, [{ productId: shampoo.id, quantity: 3 }]);
    expect(order.total).toBe(9900 + 880);
    await settle(t, payment.paymentId, true);
    expect(await ecStock(t, shampoo.id)).toBe(7);
    const processing = await t.owner.post(`/v1/orders/${order.id}/process`, {});
    expect(processing.body.status).toBe('processing');

    const cancelled = await t.owner.post(`/v1/orders/${order.id}/cancel`, { reason: 'お客様都合' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancel_reason: 'お客様都合', refunded_amount: 10780 });
    expect(cancelled.body.payments[0]).toMatchObject({ status: 'refunded', refunded_amount: 10780 });
    expect(await ecStock(t, shampoo.id)).toBe(10);
    const ev = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('domain_events').select('payload').where('event_type', '=', 'order.cancelled').where('aggregate_id', '=', order.id).executeTakeFirstOrThrow());
    expect(ev.payload).toMatchObject({ orderId: order.id, refundedAmount: 10780 });
    expect((await t.owner.post(`/v1/orders/${order.id}/cancel`, { reason: '再度' })).body.error.code).toBe('ORDER_ALREADY_CANCELLED');
  });

  it('keeps failed payments pending for retry, expires unpaid orders and refunds late payments', async () => {
    const env = await setup();
    const { t, shopper, tea } = env;
    const { order, payment } = await placeOrder(env, [{ productId: tea.id, quantity: 2 }]);
    expect(await ecStock(t, tea.id)).toBe(3);

    await settle(t, payment.paymentId, false);
    const failed = (await shopper.get(`/v1/public/me/orders/${order.id}`)).body;
    expect(failed).toMatchObject({ status: 'pending', paymentFailed: true });
    expect(await ecStock(t, tea.id)).toBe(3); // reservation kept for the retry

    const retry = await shopper.post(`/v1/public/me/orders/${order.id}/pay`, {});
    expect(retry.status).toBe(200);
    expect(retry.body.payment.paymentId).not.toBe(payment.paymentId);
    // fetching again without a new failure returns the same attempt
    expect((await shopper.post(`/v1/public/me/orders/${order.id}/pay`, {})).body.payment.paymentId).toBe(retry.body.payment.paymentId);

    // the order expires before the retry is paid → cancelled, stock released
    await asSystem(t.organizationId, (ctx) => ctx.trx.updateTable('orders').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', order.id).execute());
    await makeJobsDue(t.organizationId, 'commerce.expire_order');
    await runJobs();
    const expired = (await t.owner.get(`/v1/orders/${order.id}`)).body;
    expect(expired).toMatchObject({ status: 'cancelled', refunded_amount: 0 });
    expect(await ecStock(t, tea.id)).toBe(5);
    expect((await shopper.post(`/v1/public/me/orders/${order.id}/pay`, {})).body.error.code).toBe('ORDER_NOT_PAYABLE');

    // late success of the retry → automatically refunded
    await settle(t, retry.body.payment.paymentId, true);
    await runJobs();
    const after = (await t.owner.get(`/v1/orders/${order.id}`)).body;
    expect(after.status).toBe('cancelled');
    expect(after.payments.find((p: { id: string }) => p.id === retry.body.payment.paymentId)).toMatchObject({ status: 'refunded' });
  });

  it('does not cancel a pending order before it expires', async () => {
    const env = await setup();
    const { order } = await placeOrder(env, [{ productId: env.tea.id, quantity: 1 }]);
    await makeJobsDue(env.t.organizationId, 'commerce.expire_order');
    await runJobs();
    expect((await env.t.owner.get(`/v1/orders/${order.id}`)).body.status).toBe('pending');
    // re-scheduled for the real deadline
    const queued = await asSystem(env.t.organizationId, (ctx) =>
      ctx.trx.selectFrom('jobs').select(['dedupe_key', 'run_at']).where('type', '=', 'commerce.expire_order').where('state', '=', 'queued').where('dedupe_key', 'like', `order-expire:${order.id}:%`).execute(),
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]!.run_at.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
  });

  it('rejects insufficient stock, unavailable products and wrong callers', async () => {
    const env = await setup();
    const { t, shopper, shampoo, slug } = env;
    const tooMany = await shopper.post('/v1/public/orders', { shopSlug: slug, items: [{ productId: shampoo.id, quantity: 11 }], shippingAddress: address, idempotencyKey: randomUUID() });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(tooMany.body.error.message).toContain('シャンプー');
    expect(await ecStock(t, shampoo.id)).toBe(10);
    expect((await t.owner.get('/v1/orders')).body.items).toHaveLength(0);

    const offline = (await t.owner.post('/v1/products', { name: '店頭のみ', price: 1000 })).body;
    const unavailable = await shopper.post('/v1/public/orders', { shopSlug: slug, items: [{ productId: offline.id, quantity: 1 }], shippingAddress: address, idempotencyKey: randomUUID() });
    expect(unavailable.body.error.code).toBe('PRODUCT_UNAVAILABLE');
    expect((await shopper.post('/v1/public/orders', { shopSlug: slug, items: [{ productId: shampoo.id, quantity: 1 }], shippingAddress: { ...address, postalCode: '12' }, idempotencyKey: randomUUID() })).status).toBe(400);

    // free shipping over the threshold
    const big = await placeOrder(env, [{ productId: shampoo.id, quantity: 4 }]);
    expect(big.order.total).toBe(13200);

    // staff token / anonymous / customer of another organization
    const order = { shopSlug: slug, items: [{ productId: shampoo.id, quantity: 1 }], shippingAddress: address, idempotencyKey: randomUUID() };
    expect((await t.owner.post('/v1/public/orders', order)).status).toBe(403);
    const other = await createTenant('他社');
    const otherShopper = await customerApi(other, (await createCustomer(other)).id);
    expect((await otherShopper.post('/v1/public/orders', order)).status).toBe(404);
    expect((await other.owner.get(`/v1/orders/${big.order.id}`)).status).toBe(404);
    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.get('/v1/orders')).status).toBe(403);
    expect((await stylist.api.post(`/v1/orders/${big.order.id}/ship`, { carrier: 'x', trackingNumber: 'y' })).status).toBe(403);
  });
});

describe('commerce sales', () => {
  it('reports sales by product and by staff combining EC orders and POS product lines', async () => {
    const env = await setup();
    const { t, shampoo, tea } = env;
    const stylist = await createStaffUser(t, 'stylist', { displayName: '売上スタイリスト' });
    const link = (await t.owner.post('/v1/referral-links', { name: '紹介', staffId: stylist.staffId })).body;
    const { payment } = await placeOrder(env, [{ productId: shampoo.id, quantity: 1 }, { productId: tea.id, quantity: 2 }], { referralCode: link.code });
    await settle(t, payment.paymentId, true);
    const unpaid = await placeOrder(env, [{ productId: shampoo.id, quantity: 1 }]);
    expect(unpaid.order.status).toBe('pending');

    // POS sale of the shampoo by the stylist
    await asSystem(t.organizationId, async (ctx) => {
      const tx = await ctx.trx
        .insertInto('transactions')
        .values({ organization_id: t.organizationId, shop_id: t.shopId, status: 'completed', subtotal: 3300, total: 3300, completed_at: new Date() })
        .returning('id')
        .executeTakeFirstOrThrow();
      const item = await ctx.trx
        .insertInto('transaction_items')
        .values({ organization_id: t.organizationId, transaction_id: tx.id, item_type: 'product', product_id: shampoo.id, name: 'シャンプー', quantity: 1, unit_price: 3300, amount: 3300 })
        .returning('id')
        .executeTakeFirstOrThrow();
      await ctx.trx.insertInto('transaction_item_staff').values({ organization_id: t.organizationId, transaction_item_id: item.id, staff_id: stylist.staffId, share_bp: 10000, allocated_amount: 3300 }).execute();
    });

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
    const byProduct = await t.owner.get('/v1/commerce/sales', { from: today, to: today, groupBy: 'product' });
    expect(byProduct.status).toBe(200);
    const sh = byProduct.body.rows.find((r: { productId: string }) => r.productId === shampoo.id);
    expect(sh).toMatchObject({ name: 'シャンプー', online: { quantity: 1, amount: 3300 }, store: { quantity: 1, amount: 3300 }, total: 6600 });
    expect(byProduct.body.rows.find((r: { productId: string }) => r.productId === tea.id)).toMatchObject({ online: { quantity: 2, amount: 2160 }, store: { amount: 0 } });
    expect(byProduct.body.totals).toEqual({ online: 5460, store: 3300, total: 8760 });

    const byStaff = await t.owner.get('/v1/commerce/sales', { from: today, to: today, groupBy: 'staff' });
    expect(byStaff.body.rows).toEqual([expect.objectContaining({ staffId: stylist.staffId, name: '売上スタイリスト', online: expect.objectContaining({ amount: 5460, orders: 1 }), store: expect.objectContaining({ amount: 3300 }), total: 8760 })]);

    // stylist sees only own figures (sales.read_own); range validation
    const own = await stylist.api.get('/v1/commerce/sales', { from: today, to: today, groupBy: 'staff' });
    expect(own.status).toBe(200);
    expect(own.body.totals.total).toBe(8760);
    const assistant = await createStaffUser(t, 'assistant');
    expect((await assistant.api.get('/v1/commerce/sales', { from: today, to: today })).status).toBe(403);
    expect((await t.owner.get('/v1/commerce/sales', { from: '2026-10-02', to: '2026-10-01' })).status).toBe(400);
  });
});
