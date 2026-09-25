import { beforeAll, describe, expect, it } from 'vitest';
import { localToUtc, todayIn } from '@salonos/core';
import { signStripePayload } from '@salonos/core/integrations/payments';
import { prisma } from '@salonos/db';
import { createAppointment } from '@/lib/server/booking';
import { pointsBalance } from '@/lib/server/customers';
import {
  checkout, closeRegister, createDraft, dailyReport, openRegister, refundTransaction, registerSummary, saveDraft, updateDraft, voidTransaction,
  type PosActor,
} from '@/lib/server/pos';
import { createStoreOrder, markOrderPaid, orderToken, verifyOrderToken } from '@/lib/server/commerce';
import { handlePaymentWebhook } from '@/lib/server/payments/webhooks';
import type { DraftLine } from '@/lib/pos-shared';
import { futureDate, makeOrg } from './helpers';

const TZ = 'Asia/Tokyo';
const WH_SECRET = 'whsec_test_secret_123';

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = WH_SECRET;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.SQUARE_ACCESS_TOKEN;
});

async function setup(opts: { points?: number; stock?: number } = {}) {
  const { org, shop, staff, menus } = await makeOrg({ seats: 5 });
  const actor: PosActor = { orgId: org.id, userId: staff[0].userId, shopIds: [shop.id] };
  const customer = await prisma.customer.create({ data: { organizationId: org.id, lastName: '山田', firstName: '花子' } });
  if (opts.points) await prisma.pointLedger.create({ data: { organizationId: org.id, customerId: customer.id, delta: opts.points, reason: '初期' } });
  const product = await prisma.product.create({ data: { organizationId: org.id, name: 'シャンプー', price: 3300, stock: opts.stock ?? 10, subscriptionIntervalDays: 30 } });
  const cut = menus.find((m) => m.name === 'カット')!;
  const color = menus.find((m) => m.name === 'カラー')!;
  return { org, shop, staff, menus, actor, customer, product, cut, color };
}

const svc = (m: { id: string; name: string; price: number }, staffId?: string): DraftLine => ({ kind: 'SERVICE', menuId: m.id, productId: null, name: m.name, unitPrice: m.price, quantity: 1, discount: 0, staffId: staffId ?? null, nominated: false });
const retail = (p: { id: string; name: string; price: number }, quantity = 1): DraftLine => ({ kind: 'RETAIL', menuId: null, productId: p.id, name: p.name, unitPrice: p.price, quantity, discount: 0, staffId: null, nominated: false });
const draft = (lines: DraftLine[], extra: Partial<{ customerId: string | null; pointsToUse: number; manualDiscount: number; couponId: string | null }> = {}) =>
  ({ lines, manualDiscount: 0, pointsToUse: 0, ...extra });

describe('POS drafts', () => {
  it('creates a draft from an appointment with staff attribution, nomination fee and reuse', async () => {
    const { org, shop, staff, actor, customer, cut, color } = await setup();
    await prisma.membership.update({ where: { id: staff[1].membershipId }, data: { nominationFee: 1100 } });
    const date = futureDate(2);
    const { appointmentId } = await createAppointment({
      orgId: org.id, shopId: shop.id, customerId: customer.id, staffId: staff[1].userId, nominated: true,
      startAt: localToUtc(date, 11 * 60, TZ), menus: [{ menuId: cut.id, name: cut.name, price: cut.price, durationMin: 60 }, { menuId: color.id, name: color.name, price: color.price, durationMin: 90 }],
    });
    const first = await createDraft(actor, { shopId: shop.id, appointmentId });
    expect(first.created).toBe(true);
    const t = await prisma.transaction.findUniqueOrThrow({ where: { id: first.id }, include: { items: true } });
    expect(t.status).toBe('DRAFT');
    expect(t.customerId).toBe(customer.id);
    expect(t.staffId).toBe(staff[1].userId);
    expect(t.items).toHaveLength(3);
    expect(t.items.filter((i) => i.kind === 'SERVICE').every((i) => i.staffId === staff[1].userId && i.nominated)).toBe(true);
    expect(t.items.find((i) => i.name === '指名料')?.unitPrice).toBe(1100);
    expect(t.total).toBe(5500 + 8800 + 1100);
    expect(t.taxTotal).toBe(Math.floor((15400 * 10) / 110));

    // reuse (sequential and concurrent)
    const again = await Promise.all(Array.from({ length: 5 }, () => createDraft(actor, { shopId: shop.id, appointmentId })));
    expect(new Set(again.map((a) => a.id))).toEqual(new Set([first.id]));
    expect(await prisma.transaction.count({ where: { appointmentId } })).toBe(1);
  });

  it('rejects foreign shops, menus and over-balance points', async () => {
    const a = await setup({ points: 100 });
    const b = await setup();
    await expect(createDraft(a.actor, { shopId: b.shop.id })).rejects.toThrow(/アクセス権/);
    const d = await createDraft(a.actor, { shopId: a.shop.id, customerId: a.customer.id });
    await expect(updateDraft(a.actor, d.id, draft([svc(b.cut)]))).rejects.toThrow(/メニュー/);
    await expect(updateDraft(a.actor, d.id, draft([svc(a.cut)], { customerId: a.customer.id, pointsToUse: 101 }))).rejects.toThrow(/ポイント残高/);
    await expect(updateDraft(b.actor, d.id, draft([svc(b.cut)]))).rejects.toThrow(/見つかりません/);
  });

  it('applies coupon, line and manual discounts tax-inclusively', async () => {
    const { shop, org, actor, cut, color } = await setup();
    const coupon = await prisma.coupon.create({ data: { organizationId: org.id, shopId: shop.id, name: '10%OFF', discountType: 'PERCENT', discountValue: 10, menuIds: [] } });
    const d = await createDraft(actor, { shopId: shop.id });
    const lines = [{ ...svc(cut), discount: 500 }, svc(color)];
    const r = await updateDraft(actor, d.id, draft(lines, { couponId: coupon.id, manualDiscount: 300 }));
    // (5500-500 + 8800) = 13800 → coupon 1380 → manual 300 → 12120
    expect(r.totals.total).toBe(12120);
    expect(r.totals.discountTotal).toBe(500 + 1380 + 300);
    expect(r.totals.taxTotal).toBe(Math.floor((12120 * 10) / 110));
    const expired = await prisma.coupon.create({ data: { organizationId: org.id, shopId: shop.id, name: '期限切れ', discountValue: 100, menuIds: [], validTo: new Date(Date.now() - 86400000) } });
    await expect(updateDraft(actor, d.id, draft(lines, { couponId: expired.id }))).rejects.toThrow(/有効期限/);
  });
});

describe('POS checkout', () => {
  it('settles split tender with change, completes the appointment and updates stats', async () => {
    const { org, shop, staff, actor, customer, cut, color } = await setup();
    const { appointmentId } = await createAppointment({ orgId: org.id, shopId: shop.id, customerId: customer.id, staffId: staff[0].userId, startAt: localToUtc(futureDate(1), 13 * 60, TZ), menus: [{ menuId: cut.id, name: cut.name, price: cut.price, durationMin: 60 }, { menuId: color.id, name: color.name, price: color.price, durationMin: 60 }] });
    const d = await createDraft(actor, { shopId: shop.id, appointmentId });

    // cash requires an open register
    await expect(checkout(actor, d.id, { tenders: [{ method: 'CASH', amount: 20000 }] })).rejects.toThrow(/レジが開いていません/);
    await openRegister(actor, shop.id, 10000);
    // card may never over-collect; under-payment is rejected
    await expect(checkout(actor, d.id, { tenders: [{ method: 'CARD', amount: 20000 }] })).rejects.toThrow(/超えています/);
    await expect(checkout(actor, d.id, { tenders: [{ method: 'CARD', amount: 1000 }] })).rejects.toThrow(/未収/);
    await expect(checkout(actor, d.id, { tenders: [{ method: 'CARD', amount: 14300 }], expectedTotal: 9999 })).rejects.toThrow(/金額が変更/);

    const r = await checkout(actor, d.id, { tenders: [{ method: 'CARD', amount: 5000, reference: '123456' }, { method: 'CASH', amount: 10000 }], expectedTotal: 14300 });
    expect(r.total).toBe(14300);
    expect(r.change).toBe(700);
    const t = await prisma.transaction.findUniqueOrThrow({ where: { id: d.id }, include: { payments: true } });
    expect(t.status).toBe('PAID');
    expect(t.paidAt).toBeTruthy();
    expect(t.registerSessionId).toBeTruthy();
    const byMethod = Object.fromEntries(t.payments.map((p) => [p.method, p]));
    expect(byMethod.CARD.amount).toBe(5000);
    expect(byMethod.CARD.label).toContain('123456');
    expect(byMethod.CASH.amount).toBe(9300);
    expect(byMethod.CASH.label).toBe('お預り:10000');
    expect(t.payments.reduce((a, p) => a + p.amount, 0)).toBe(t.total);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } })).status).toBe('COMPLETED');
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(c.visitCount).toBe(1);
    expect(c.totalSales).toBe(14300);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: 'pos.checkout', resourceId: d.id } })).toBe(1);
    // a paid ticket can no longer be edited
    await expect(updateDraft(actor, d.id, draft([svc(cut)]))).rejects.toThrow(/確定済み/);
    await expect(createDraft(actor, { shopId: shop.id, appointmentId })).rejects.toThrow(/会計済み/);
  });

  it('redeems and earns points against the ledger balance', async () => {
    const { shop, actor, customer, cut, color } = await setup({ points: 500 });
    const d = await saveDraft(actor, { shopId: shop.id, draft: draft([svc(cut), svc(color)], { customerId: customer.id, pointsToUse: 300 }) });
    expect(d.totals.total).toBe(14300 - 300);
    expect(d.totals.pointsEarned).toBe(Math.floor(14000 / 100));
    await checkout(actor, d.id, { tenders: [{ method: 'EMONEY', amount: 14000 }] });
    expect(await pointsBalance(customer.id)).toBe(500 - 300 + 140);
    const t = await prisma.transaction.findUniqueOrThrow({ where: { id: d.id } });
    expect([t.pointsUsed, t.pointsEarned]).toEqual([300, 140]);
  });

  it('prevents overspending points across concurrent tickets', async () => {
    const { shop, actor, customer, cut } = await setup({ points: 500 });
    const a = await saveDraft(actor, { shopId: shop.id, draft: draft([svc(cut)], { customerId: customer.id, pointsToUse: 400 }) });
    const b = await saveDraft(actor, { shopId: shop.id, draft: draft([svc(cut)], { customerId: customer.id, pointsToUse: 400 }) });
    const rs = await Promise.allSettled([a, b].map((d) => checkout(actor, d.id, { tenders: [{ method: 'CARD', amount: 5100 }] })));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await pointsBalance(customer.id)).toBeGreaterThanOrEqual(0);
  });

  it('allows only one concurrent checkout of the same ticket', async () => {
    const { org, shop, actor, customer, cut } = await setup({ points: 100 });
    await openRegister(actor, shop.id, 0);
    const d = await saveDraft(actor, { shopId: shop.id, draft: draft([svc(cut)], { customerId: customer.id, pointsToUse: 100 }) });
    const rs = await Promise.allSettled(Array.from({ length: 6 }, () => checkout(actor, d.id, { tenders: [{ method: 'CASH', amount: 6000 }] })));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.every((r) => /確定済み/.test(r.reason.message))).toBe(true);
    expect(await prisma.payment.count({ where: { transactionId: d.id } })).toBe(1);
    expect(await prisma.pointLedger.count({ where: { transactionId: d.id } })).toBe(2);
    expect(await pointsBalance(customer.id)).toBe(100 - 100 + 54);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: 'pos.checkout' } })).toBe(1);
  });

  it('decrements stock for retail lines', async () => {
    const { shop, actor, product, cut } = await setup({ stock: 10 });
    const d = await saveDraft(actor, { shopId: shop.id, draft: draft([svc(cut), retail(product, 3)]) });
    expect(d.totals.retailTotal).toBe(9900);
    await checkout(actor, d.id, { tenders: [{ method: 'QR', amount: 5500 + 9900 }] });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(7);
  });

  it('records sandbox provider tenders and zero-total (all points) tickets', async () => {
    const { shop, actor, customer, cut } = await setup({ points: 10000 });
    const d = await saveDraft(actor, { shopId: shop.id, draft: draft([svc(cut)], { customerId: customer.id, pointsToUse: 5500 }) });
    const r = await checkout(actor, d.id, { tenders: [] });
    expect(r.total).toBe(0);
    const d2 = await saveDraft(actor, { shopId: shop.id, draft: draft([svc(cut)]) });
    await checkout(actor, d2.id, { tenders: [{ method: 'STRIPE', amount: 5500 }] });
    const p = await prisma.payment.findFirstOrThrow({ where: { transactionId: d2.id } });
    expect(p.externalRef).toMatch(/^sandbox_stripe_/);
    await expect(checkout(actor, (await saveDraft(actor, { shopId: shop.id, draft: draft([svc(cut)]) })).id, { tenders: [{ method: 'CUSTOM', amount: 5500 }] })).rejects.toThrow(/名称/);
  });
});

describe('POS refunds and voids', () => {
  async function paidTicket(opts: { points?: number; stock?: number } = {}) {
    const s = await setup({ points: opts.points ?? 200, stock: opts.stock });
    await openRegister(s.actor, s.shop.id, 5000);
    const d = await saveDraft(s.actor, { shopId: s.shop.id, draft: draft([svc(s.color), retail(s.product, 2)], { customerId: s.customer.id, pointsToUse: 100 }) });
    // 8800 + 6600 − 100 = 15300 → earn 153
    await checkout(s.actor, d.id, { tenders: [{ method: 'CARD', amount: 15300 }] });
    return { ...s, txId: d.id };
  }

  it('enforces refund bounds and reverses earned points proportionally', async () => {
    const { org, actor, customer, product, txId } = await paidTicket({ stock: 10 });
    expect(await pointsBalance(customer.id)).toBe(200 - 100 + 153);
    const item = (await prisma.transactionItem.findFirstOrThrow({ where: { transactionId: txId, kind: 'RETAIL' } }));

    const r1 = await refundTransaction(actor, txId, { amount: 5100, method: 'CARD', reason: '一部返品', restock: [{ itemId: item.id, quantity: 1 }] });
    expect(r1.status).toBe('PARTIALLY_REFUNDED');
    expect(r1.pointsReversed).toBe(Math.floor((153 * 5100) / 15300)); // 51
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(10 - 2 + 1);
    await expect(refundTransaction(actor, txId, { amount: 10201, method: 'CARD' })).rejects.toThrow(/返金可能額/);
    await expect(refundTransaction(actor, txId, { amount: 0, method: 'CARD' })).rejects.toThrow(/返金額/);
    await expect(refundTransaction(actor, txId, { amount: 100, method: 'CARD', restock: [{ itemId: item.id, quantity: 2 }] })).rejects.toThrow(/返品数量/);

    const r2 = await refundTransaction(actor, txId, { amount: 10200, method: 'CASH', reason: '全額返金' });
    expect(r2.status).toBe('REFUNDED');
    expect(r2.refundedTotal).toBe(15300);
    // all earned points reversed, used points returned
    expect(await pointsBalance(customer.id)).toBe(200);
    await expect(refundTransaction(actor, txId, { amount: 1, method: 'CARD' })).rejects.toThrow(/返金できません/);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: 'pos.refund', resourceId: txId } })).toBe(2);
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(c.visitCount).toBe(0);
  });

  it('voids same-day tickets (points, stock, payments, appointment release) but not older ones', async () => {
    const { org, shop, staff, actor, customer, product, cut } = await setup({ points: 0, stock: 5 });
    const { appointmentId } = await createAppointment({ orgId: org.id, shopId: shop.id, customerId: customer.id, staffId: staff[0].userId, startAt: localToUtc(futureDate(1), 15 * 60, TZ), menus: [{ menuId: cut.id, name: cut.name, price: cut.price, durationMin: 60 }] });
    const d = await createDraft(actor, { shopId: shop.id, appointmentId });
    await updateDraft(actor, d.id, draft([svc(cut), retail(product, 1)], { customerId: customer.id }));
    await checkout(actor, d.id, { tenders: [{ method: 'CARD', amount: 8800 }] });
    expect(await pointsBalance(customer.id)).toBe(88);

    const tomorrow = new Date(Date.now() + 86400000 * 1.5);
    await expect(voidTransaction(actor, d.id, 'test', tomorrow)).rejects.toThrow(/当日/);

    await voidTransaction(actor, d.id, '打ち間違い');
    const t = await prisma.transaction.findUniqueOrThrow({ where: { id: d.id }, include: { payments: true } });
    expect(t.status).toBe('VOID');
    expect(t.appointmentId).toBeNull();
    expect(t.payments.every((p) => p.status === 'REFUNDED')).toBe(true);
    expect(await pointsBalance(customer.id)).toBe(0);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(5);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: 'pos.void', resourceId: d.id } })).toBe(1);
    await expect(voidTransaction(actor, d.id)).rejects.toThrow(/取消済み/);
    // the appointment can be rung up again
    const again = await createDraft(actor, { shopId: shop.id, appointmentId });
    expect(again.id).not.toBe(d.id);
  });

  it('voids drafts without side effects', async () => {
    const { shop, actor, cut } = await setup();
    const d = await saveDraft(actor, { shopId: shop.id, draft: draft([svc(cut)]) });
    await voidTransaction(actor, d.id);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('VOID');
    await expect(checkout(actor, d.id, { tenders: [{ method: 'CARD', amount: 5500 }] })).rejects.toThrow(/確定済み/);
  });
});

describe('register', () => {
  it('computes expected cash and the difference on close', async () => {
    const { shop, actor, cut, color } = await setup();
    const reg = await openRegister(actor, shop.id, 10000);
    await expect(openRegister(actor, shop.id, 0)).rejects.toThrow(/既にレジ/);
    const a = await saveDraft(actor, { shopId: shop.id, draft: draft([svc(cut)]) });
    await checkout(actor, a.id, { tenders: [{ method: 'CASH', amount: 10000 }] }); // cash 5500, change 4500
    const b = await saveDraft(actor, { shopId: shop.id, draft: draft([svc(color)]) });
    await checkout(actor, b.id, { tenders: [{ method: 'CARD', amount: 8800 }] });
    await refundTransaction(actor, a.id, { amount: 1000, method: 'CASH', reason: '返金' });

    const live = await registerSummary(prisma, reg.id);
    expect(live.cashSales).toBe(5500);
    expect(live.cashRefunds).toBe(1000);
    expect(live.expectedCash).toBe(10000 + 5500 - 1000);
    expect(live.byMethod).toEqual({ CASH: 5500, CARD: 8800 });
    expect(live.txCount).toBe(2);

    const closed = await closeRegister(actor, reg.id, 14000, '500円不足');
    expect(closed.expectedCash).toBe(14500);
    expect(closed.difference).toBe(-500);
    expect((closed.summary as any).salesTotal).toBe(14300);
    await expect(closeRegister(actor, reg.id, 14000)).rejects.toThrow(/既に締め/);

    const report = await dailyReport(actor, shop.id, todayIn(TZ));
    expect(report.gross).toBe(14300);
    expect(report.refundTotal).toBe(1000);
    expect(report.net).toBe(13300);
    expect(report.byMethod.CASH).toBe(5500);
  });
});

describe('payment webhooks & storefront orders', () => {
  const stripeEvent = (id: string, type: string, object: Record<string, unknown>) => JSON.stringify({ id, type, data: { object } });
  const send = (body: string) => handlePaymentWebhook('STRIPE', body, new Headers({ 'stripe-signature': signStripePayload(body, WH_SECRET) }), new URL('http://localhost/api/webhooks/stripe'));

  it('rejects bad signatures', async () => {
    const body = stripeEvent('evt_bad', 'payment_intent.succeeded', {});
    const r = await handlePaymentWebhook('STRIPE', body, new Headers({ 'stripe-signature': signStripePayload(body, 'wrong') }), new URL('http://localhost/api/webhooks/stripe'));
    expect(r.status).toBe(400);
  });

  it('marks an order paid once and creates subscriptions (idempotent replay)', async () => {
    const { shop, product } = await setup({ stock: 10 });
    const other = await prisma.product.create({ data: { organizationId: shop.organizationId, name: 'ワックス', price: 2200, stock: 4 } });
    const o = await createStoreOrder({
      shopSlug: shop.slug, items: [{ productId: product.id, quantity: 2 }, { productId: other.id, quantity: 1 }],
      name: '佐藤 一郎', email: 'ichiro@example.com', phone: '090-1111-2222', address: '東京都渋谷区1-2-3', postalCode: '150-0001', subscribe: true,
    });
    expect(o.sandbox).toBe(true);
    expect(verifyOrderToken(o.orderId, o.token)).toBe(true);
    expect(verifyOrderToken(o.orderId, orderToken('other'))).toBe(false);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
    expect(order.status).toBe('PENDING');
    expect(order.total).toBe(6600 + 2200); // free shipping over ¥5,500
    expect(order.contactEmailEnc).not.toContain('ichiro');
    expect(order.customerId).toBeTruthy();

    const body = stripeEvent('evt_order_1', 'payment_intent.succeeded', { id: 'pi_order_1', amount_received: order.total, metadata: { order_id: order.id } });
    const [r1, r2] = [await send(body), await send(body)];
    expect(r1.body).toMatchObject({ ok: true, processed: true });
    expect(r2.body).toMatchObject({ ok: true, duplicate: true });
    // a second, distinct event for the same payment is also a no-op
    await send(stripeEvent('evt_order_2', 'checkout.session.completed', { id: 'cs_1', payment_intent: 'pi_order_1', payment_status: 'paid', amount_total: order.total, metadata: { order_id: order.id } }));

    const paid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(paid.status).toBe('PAID');
    expect(paid.paymentRef).toBe('pi_order_1');
    const subs = await prisma.subscription.findMany({ where: { orderId: order.id } });
    expect(subs).toHaveLength(1); // only the product with an interval
    expect(subs[0]).toMatchObject({ productId: product.id, quantity: 2, intervalDays: 30, status: 'ACTIVE' });
    expect(Math.round((subs[0].nextShipAt.getTime() - Date.now()) / 86400000)).toBe(30);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(8);
    expect(await prisma.webhookEvent.count({ where: { provider: 'STRIPE', eventId: 'evt_order_1' } })).toBe(1);
    expect((await markOrderPaid(order.id, { provider: 'STRIPE' })).changed).toBe(false);

    // full refund from the provider dashboard
    await send(stripeEvent('evt_order_3', 'charge.refunded', { id: 'ch_1', payment_intent: 'pi_order_1', amount_refunded: order.total }));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('REFUNDED');
    expect(await prisma.subscription.count({ where: { orderId: order.id, status: 'CANCELLED' } })).toBe(1);
  });

  it('ignores under-paid orders', async () => {
    const { shop, product } = await setup();
    const o = await createStoreOrder({ shopSlug: shop.slug, items: [{ productId: product.id, quantity: 1 }], name: 'A B', email: 'a@example.com', phone: '09011112222', address: 'x' });
    const r = await send(stripeEvent('evt_under', 'payment_intent.succeeded', { id: 'pi_under', amount_received: 100, metadata: { order_id: o.orderId } }));
    expect(r.body.processed).toBe(false);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe('PENDING');
  });

  it('finalizes a POS draft from a payment webhook and records provider refunds once', async () => {
    const { shop, actor, customer, cut } = await setup();
    const d = await saveDraft(actor, { shopId: shop.id, draft: draft([svc(cut)], { customerId: customer.id }) });
    const body = stripeEvent('evt_tx_1', 'payment_intent.succeeded', { id: 'pi_tx_1', amount_received: 5500, metadata: { transaction_id: d.id } });
    await Promise.all([send(body), send(body), send(body)]);
    const t = await prisma.transaction.findUniqueOrThrow({ where: { id: d.id }, include: { payments: true } });
    expect(t.status).toBe('PAID');
    expect(t.payments).toHaveLength(1);
    expect(t.payments[0]).toMatchObject({ method: 'STRIPE', externalRef: 'pi_tx_1', amount: 5500 });
    expect(await pointsBalance(customer.id)).toBe(55);

    const refund = (evt: string) => stripeEvent(evt, 'charge.refunded', { id: 'ch_tx', payment_intent: 'pi_tx_1', amount_refunded: 2000, refunds: { data: [{ id: 're_1', amount: 2000, status: 'succeeded' }] } });
    await send(refund('evt_tx_r1'));
    await send(refund('evt_tx_r1'));
    await send(refund('evt_tx_r2')); // different event, same refund object
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: d.id }, include: { refunds: true } });
    expect(after.refunds).toHaveLength(1);
    expect(after.refundedTotal).toBe(2000);
    expect(after.status).toBe('PARTIALLY_REFUNDED');
    expect(await prisma.webhookEvent.count({ where: { eventId: { in: ['evt_tx_1', 'evt_tx_r1', 'evt_tx_r2'] } } })).toBe(3);
  });
});
