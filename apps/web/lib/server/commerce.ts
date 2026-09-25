// Storefront EC: orders, payment completion, subscriptions, recommendations, fulfillment.
import type { OrderStatus, Prisma } from '@salonos/db';
import { hmacHex, randomToken } from '@salonos/core/crypto';
import { prisma, type Tx } from './db';
import { AppError, NotFoundError } from './errors';
import { audit } from './audit';
import { encryptField } from './pii';
import { resolveCustomer } from './customers';
import { cryptoKeys, env } from './env';
import { createCheckoutSession, createStripeRefund, stripeConfig } from './payments/stripe';
import { createSquareRefund } from './payments/square';
import { shippingFeeFor } from '../pos-shared';

type Db = Tx | typeof prisma;

// ── Order access token (no schema column needed): HMAC of the order id with a server key ──

function orderKey(): string {
  return `order-link:${cryptoKeys().hashKey.toString('hex')}`;
}
export function orderToken(orderId: string): string {
  return hmacHex(orderKey(), `order:${orderId}`).slice(0, 40);
}
export function verifyOrderToken(orderId: string, token: string | null | undefined): boolean {
  if (!token || token.length !== 40) return false;
  const expected = orderToken(orderId);
  let diff = 0;
  for (let i = 0; i < 40; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
export function orderUrl(shopSlug: string, orderId: string, extra = '') {
  return `/store/${shopSlug}/order/${orderId}?t=${orderToken(orderId)}${extra}`;
}

// ── Catalog ──

export async function storeShop(slug: string) {
  return prisma.shop.findFirst({
    where: { slug, active: true },
    select: { id: true, name: true, slug: true, organizationId: true, description: true, imageUrl: true, phone: true, address: true, organization: { select: { name: true } } },
  });
}

export async function storeProducts(orgId: string) {
  return prisma.product.findMany({
    where: { organizationId: orgId, active: true, onlineSale: true },
    orderBy: [{ brand: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, brand: true, description: true, price: true, stock: true, imageUrl: true, subscriptionIntervalDays: true, sku: true },
  });
}

export async function recommendationByToken(token: string) {
  if (!token || token.length > 64) return null;
  const rec = await prisma.productRecommendation.findUnique({ where: { token } });
  if (!rec) return null;
  const [shop, staff, products] = await Promise.all([
    prisma.shop.findFirst({ where: { id: rec.shopId, organizationId: rec.organizationId, active: true }, select: { id: true, slug: true, name: true } }),
    prisma.membership.findFirst({ where: { organizationId: rec.organizationId, userId: rec.staffId }, select: { displayName: true, imageUrl: true } }),
    prisma.product.findMany({ where: { id: { in: rec.productIds }, organizationId: rec.organizationId, active: true, onlineSale: true } }),
  ]);
  if (!shop) return null;
  return { rec, shop, staff, products: rec.productIds.map((id) => products.find((p) => p.id === id)).filter(Boolean) as typeof products };
}

// ── Order creation (public) ──

export interface StoreOrderInput {
  shopSlug: string;
  items: { productId: string; quantity: number }[];
  name: string; email: string; phone: string;
  postalCode?: string | null; address: string;
  subscribe?: boolean;
  recToken?: string | null;
  idempotencyKey?: string | null;
}

export interface StoreOrderResult { orderId: string; token: string; redirectUrl: string | null; sandbox: boolean }

export async function createStoreOrder(input: StoreOrderInput): Promise<StoreOrderResult> {
  const shop = await storeShop(input.shopSlug);
  if (!shop) throw new NotFoundError('ストアが見つかりません');
  const qty = new Map<string, number>();
  for (const i of input.items) {
    if (!Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 99) throw new AppError('数量が正しくありません');
    qty.set(i.productId, (qty.get(i.productId) ?? 0) + i.quantity);
  }
  if (!qty.size) throw new AppError('カートが空です');
  if (qty.size > 50) throw new AppError('商品の種類が多すぎます');
  const products = await prisma.product.findMany({ where: { id: { in: [...qty.keys()] }, organizationId: shop.organizationId, active: true, onlineSale: true } });
  if (products.length !== qty.size) throw new AppError('販売を終了した商品がカートに含まれています。カートを確認してください');
  for (const p of products) if (p.stock < (qty.get(p.id) ?? 0)) throw new AppError(`「${p.name}」の在庫が不足しています（残り${Math.max(0, p.stock)}点）`);
  const subscribe = !!input.subscribe && products.some((p) => p.subscriptionIntervalDays);
  const subtotal = products.reduce((a, p) => a + p.price * (qty.get(p.id) ?? 0), 0);
  const shippingFee = shippingFeeFor(subtotal);
  const total = subtotal + shippingFee;

  let rec: { id: string; staffId: string; customerId: string | null } | null = null;
  if (input.recToken) {
    const r = await prisma.productRecommendation.findUnique({ where: { token: input.recToken } });
    if (r && r.organizationId === shop.organizationId) rec = { id: r.id, staffId: r.staffId, customerId: r.customerId };
  }
  const address = [input.postalCode ? `〒${input.postalCode}` : null, input.address].filter(Boolean).join(' ');

  const order = await prisma.$transaction(async (tx) => {
    const { customerId } = await resolveCustomer(tx, { orgId: shop.organizationId, shopId: shop.id, name: input.name, phone: input.phone, email: input.email });
    return tx.order.create({
      data: {
        organizationId: shop.organizationId, shopId: shop.id, customerId: rec?.customerId ?? customerId, status: 'PENDING',
        subtotal, shippingFee, total, contactName: input.name,
        contactEmailEnc: encryptField(input.email), contactPhoneEnc: encryptField(input.phone), shippingAddressEnc: encryptField(address),
        attributedStaffId: rec?.staffId ?? null, recommendationId: rec?.id ?? null, isSubscription: subscribe,
        items: { create: products.map((p) => ({ productId: p.id, name: p.name, unitPrice: p.price, quantity: qty.get(p.id)! })) },
      },
    });
  });

  const token = orderToken(order.id);
  const base = env.appUrl;
  const cfg = await stripeConfig(shop.organizationId, shop.id);
  if (cfg.live) {
    const lines = products.map((p) => ({ name: p.name, amount: p.price, quantity: qty.get(p.id)! }));
    if (shippingFee) lines.push({ name: '送料', amount: shippingFee, quantity: 1 });
    const session = await createCheckoutSession(shop.organizationId, {
      lines, metadata: { order_id: order.id, org_id: shop.organizationId }, shopId: shop.id, customerEmail: input.email,
      successUrl: `${base}${orderUrl(shop.slug, order.id, '&paid=1')}`, cancelUrl: `${base}/store/${shop.slug}/cart?cancelled=1`,
      idempotencyKey: `order:${order.id}`,
    });
    await prisma.order.update({ where: { id: order.id }, data: { paymentProvider: 'STRIPE', paymentRef: session.id } });
    return { orderId: order.id, token, redirectUrl: session.url, sandbox: false };
  }
  await prisma.order.update({ where: { id: order.id }, data: { paymentProvider: 'IN_STORE' } });
  return { orderId: order.id, token, redirectUrl: null, sandbox: true };
}

// ── Payment completion (webhook / staff) ──

/**
 * PENDING → PAID exactly once (conditional update). Creates Subscription rows for
 * subscription orders (nextShipAt = paidAt + interval) and decrements stock.
 */
export async function markOrderPaid(orderId: string, info: { provider?: string | null; paymentRef?: string | null; amount?: number | null; actor?: { orgId: string; userId: string | null } }, db?: Tx): Promise<{ changed: boolean; reason?: string }> {
  const run = async (tx: Tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) return { changed: false, reason: 'order not found' };
    if (info.actor && info.actor.orgId !== order.organizationId) throw new NotFoundError('注文が見つかりません');
    if (order.status !== 'PENDING') return { changed: false, reason: `status ${order.status}` };
    if (info.amount != null && info.amount >= 0 && info.amount < order.total) return { changed: false, reason: `amount mismatch ${info.amount} < ${order.total}` };
    const paidAt = new Date();
    const claimed = await tx.order.updateMany({
      where: { id: orderId, status: 'PENDING' },
      data: { status: 'PAID', ...(info.provider ? { paymentProvider: info.provider } : {}), ...(info.paymentRef ? { paymentRef: info.paymentRef } : {}) },
    });
    if (claimed.count !== 1) return { changed: false, reason: 'already processed' };
    for (const i of order.items) await tx.product.updateMany({ where: { id: i.productId, organizationId: order.organizationId }, data: { stock: { decrement: i.quantity } } });
    if (order.isSubscription) {
      const products = await tx.product.findMany({ where: { id: { in: order.items.map((i) => i.productId) } }, select: { id: true, subscriptionIntervalDays: true } });
      const data = order.items.flatMap((i) => {
        const days = products.find((p) => p.id === i.productId)?.subscriptionIntervalDays;
        return days ? [{ organizationId: order.organizationId, customerId: order.customerId, orderId: order.id, productId: i.productId, quantity: i.quantity, intervalDays: days, nextShipAt: new Date(paidAt.getTime() + days * 86400000) }] : [];
      });
      if (data.length) await tx.subscription.createMany({ data });
    }
    if (info.actor) await audit(info.actor, 'commerce.order.paid', 'Order', order.id, { provider: info.provider ?? null, total: order.total }, tx);
    return { changed: true };
  };
  return db ? run(db) : prisma.$transaction(run);
}

// ── Staff-side order management ──

export interface Actor { orgId: string; userId: string | null }

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['PAID', 'CANCELLED'],
  PAID: ['FULFILLED', 'REFUNDED'],
  FULFILLED: ['REFUNDED'],
  CANCELLED: [],
  REFUNDED: [],
};
export const canOrderTransition = (from: OrderStatus, to: OrderStatus) => TRANSITIONS[from].includes(to);

/** Fulfillment provider abstraction. Manual shipping just records a tracking number. */
export interface FulfillmentProvider { name: string; ship(order: { id: string; number: number }, input: { trackingNumber?: string | null }): Promise<{ trackingNumber: string | null }> }
export const manualFulfillment: FulfillmentProvider = {
  name: 'MANUAL',
  async ship(_order, input) { return { trackingNumber: input.trackingNumber?.trim() || null }; },
};

export async function transitionOrder(actor: Actor, orderId: string, to: OrderStatus, opts: { trackingNumber?: string | null; restock?: boolean; reason?: string | null } = {}, provider: FulfillmentProvider = manualFulfillment) {
  const order = await prisma.order.findFirst({ where: { id: orderId, organizationId: actor.orgId }, include: { items: true } });
  if (!order) throw new NotFoundError('注文が見つかりません');
  if (!canOrderTransition(order.status, to)) throw new AppError('この注文のステータスは変更できません');
  if (to === 'PAID') {
    const r = await markOrderPaid(orderId, { provider: order.paymentProvider ?? 'IN_STORE', actor });
    if (!r.changed) throw new AppError('支払い済みにできませんでした');
    return;
  }
  // provider refund first for real online payments
  if (to === 'REFUNDED' && order.paymentRef && !order.paymentRef.startsWith('sandbox_')) {
    if (order.paymentProvider === 'STRIPE' && order.paymentRef.startsWith('pi_')) await createStripeRefund(actor.orgId, { paymentIntent: order.paymentRef, amount: order.total, metadata: { order_id: order.id }, shopId: order.shopId, idempotencyKey: `order-refund:${order.id}` });
    else if (order.paymentProvider === 'SQUARE') await createSquareRefund(actor.orgId, { paymentId: order.paymentRef, amount: order.total, shopId: order.shopId, idempotencyKey: `order-refund:${order.id}` });
  }
  await prisma.$transaction(async (tx) => {
    const data: Prisma.OrderUpdateManyMutationInput = { status: to };
    if (to === 'FULFILLED') {
      const shipped = await provider.ship(order, { trackingNumber: opts.trackingNumber });
      data.fulfilledAt = new Date();
      data.trackingNumber = shipped.trackingNumber;
    }
    const r = await tx.order.updateMany({ where: { id: orderId, status: order.status }, data });
    if (r.count !== 1) throw new AppError('注文の状態が変更されました。画面を更新してください');
    if (to === 'REFUNDED' || to === 'CANCELLED') await tx.subscription.updateMany({ where: { orderId, status: { not: 'CANCELLED' } }, data: { status: 'CANCELLED' } });
    if (to === 'REFUNDED' && opts.restock) {
      for (const i of order.items) await tx.product.updateMany({ where: { id: i.productId, organizationId: actor.orgId }, data: { stock: { increment: i.quantity } } });
    }
    await audit(actor, `commerce.order.${to.toLowerCase()}`, 'Order', orderId, { from: order.status, to, trackingNumber: data.trackingNumber ?? null, restock: !!opts.restock, reason: opts.reason ?? null }, tx);
  });
}

export async function updateTracking(actor: Actor, orderId: string, trackingNumber: string | null) {
  const r = await prisma.order.updateMany({ where: { id: orderId, organizationId: actor.orgId }, data: { trackingNumber: trackingNumber?.trim() || null } });
  if (!r.count) throw new NotFoundError('注文が見つかりません');
  await audit(actor, 'commerce.order.tracking', 'Order', orderId, { trackingNumber });
}

// ── Subscriptions ──

export async function updateSubscription(actor: Actor, id: string, action: 'pause' | 'resume' | 'cancel' | 'shipped' | 'reschedule', nextShipAt?: Date) {
  const s = await prisma.subscription.findFirst({ where: { id, organizationId: actor.orgId } });
  if (!s) throw new NotFoundError('定期便が見つかりません');
  if (s.status === 'CANCELLED') throw new AppError('解約済みの定期便は変更できません');
  let data: Prisma.SubscriptionUpdateInput;
  switch (action) {
    case 'pause': if (s.status !== 'ACTIVE') throw new AppError('継続中の定期便のみ一時停止できます'); data = { status: 'PAUSED' }; break;
    case 'resume': if (s.status !== 'PAUSED') throw new AppError('一時停止中の定期便ではありません'); data = { status: 'ACTIVE', nextShipAt: s.nextShipAt < new Date() ? new Date(Date.now() + 86400000) : s.nextShipAt }; break;
    case 'cancel': data = { status: 'CANCELLED' }; break;
    case 'shipped': if (s.status !== 'ACTIVE') throw new AppError('継続中の定期便のみ出荷処理できます'); data = { nextShipAt: new Date(s.nextShipAt.getTime() + s.intervalDays * 86400000) }; break;
    case 'reschedule': if (!nextShipAt || Number.isNaN(nextShipAt.getTime())) throw new AppError('次回お届け日を指定してください'); data = { nextShipAt }; break;
  }
  if (action === 'shipped') {
    await prisma.$transaction(async (tx) => {
      await tx.subscription.update({ where: { id }, data });
      await tx.product.updateMany({ where: { id: s.productId, organizationId: actor.orgId }, data: { stock: { decrement: s.quantity } } });
    });
  } else await prisma.subscription.update({ where: { id }, data });
  await audit(actor, `commerce.subscription.${action}`, 'Subscription', id, nextShipAt ? { nextShipAt: nextShipAt.toISOString() } : undefined);
}

// ── Recommendations ──

export async function createRecommendation(actor: Actor & { shopIds: string[] }, input: { shopId: string; staffId: string; customerId?: string | null; productIds: string[]; message?: string | null }) {
  if (!actor.shopIds.includes(input.shopId)) throw new AppError('この店舗へのアクセス権がありません');
  const ids = [...new Set(input.productIds)];
  if (!ids.length) throw new AppError('商品を1つ以上選択してください');
  if (ids.length > 12) throw new AppError('一度におすすめできる商品は12点までです');
  const [products, staff, customer] = await Promise.all([
    prisma.product.count({ where: { id: { in: ids }, organizationId: actor.orgId, active: true, onlineSale: true } }),
    prisma.membership.findFirst({ where: { organizationId: actor.orgId, userId: input.staffId } }),
    input.customerId ? prisma.customer.findFirst({ where: { id: input.customerId, organizationId: actor.orgId, mergedIntoId: null, deletedAt: null } }) : null,
  ]);
  if (products !== ids.length) throw new AppError('オンライン販売中ではない商品が含まれています');
  if (!staff) throw new AppError('スタッフが見つかりません');
  if (input.customerId && !customer) throw new AppError('顧客が見つかりません');
  const rec = await prisma.productRecommendation.create({
    data: { token: randomToken(18), organizationId: actor.orgId, shopId: input.shopId, staffId: input.staffId, customerId: input.customerId ?? null, productIds: ids, message: input.message?.trim() || null },
  });
  await audit(actor, 'commerce.recommendation.create', 'ProductRecommendation', rec.id, { customerId: input.customerId ?? null, products: ids.length });
  return rec;
}

export function recommendationUrl(token: string) {
  return `${env.appUrl}/rec/${token}`;
}

// ── Stock ──

export async function adjustStock(actor: Actor, productId: string, delta: number, reason: string, db: Db = prisma) {
  if (!Number.isInteger(delta) || delta === 0) throw new AppError('増減数を入力してください');
  const p = await db.product.findFirst({ where: { id: productId, organizationId: actor.orgId } });
  if (!p) throw new NotFoundError('商品が見つかりません');
  const updated = await db.product.update({ where: { id: productId }, data: { stock: { increment: delta } } });
  await audit(actor, 'commerce.stock.adjust', 'Product', productId, { delta, before: p.stock, after: updated.stock, reason });
  return updated;
}
