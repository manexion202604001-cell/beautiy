import { sql } from 'kysely';
import { accessibleShopIds, assertShopAccess, can, requirePermission, type Ctx } from '../../auth/actor.js';
import { cancelJobs, enqueue } from '../../jobs/queue.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { emit } from '../../lib/events.js';
import { allocate, includedTax } from '../../lib/money.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { dayBounds } from '../../lib/time.js';
import { displayName } from '../customers/service.js';
import { resolveReferralCode } from '../marketing/api.js';
import { queueMessage } from '../messaging/api.js';
import { refundPayment, startOnlinePayment } from '../payments/api.js';
import type { PublicShop } from '../public/service.js';
import { inclusivePrice } from './products.js';
import type { CreateOrderInput, ListOrdersInput } from './schemas.js';
import { applyStockMovement } from './stock.js';

/**
 * EC orders (FR-08). Flow:
 *   POST /public/orders → pending (EC-warehouse stock reserved, online payment started)
 *   payment.succeeded → paid (order.paid) → ship (order.shipped) → deliver
 *   payment.failed → stays pending (customer may retry) until expires_at; the 'commerce.expire_order'
 *   job then cancels it and releases the reservation. cancel after payment refunds + restocks.
 * is_subscription (定期購入) is an extension point only — recurring orders are out of MVP scope.
 */

const NO_SHOP = '00000000-0000-0000-0000-000000000000';

export interface CommerceSettings {
  shippingFee: number;
  /** free shipping when the item subtotal is >= this amount; null = never free */
  freeShippingThreshold: number | null;
  shippingTaxRateBp: number;
  /** unpaid orders are cancelled after N minutes */
  paymentTimeoutMin: number;
}

/** organizations.settings.commerce (validated with defaults) */
export function commerceSettings(raw: unknown): CommerceSettings {
  const c = ((raw ?? {}) as { commerce?: Record<string, unknown> }).commerce ?? {};
  const int = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined);
  return {
    shippingFee: int(c.shippingFee, 0, 100_000) ?? 800,
    freeShippingThreshold: c.freeShippingThreshold === null ? null : (int(c.freeShippingThreshold, 0, 10_000_000) ?? 5500),
    shippingTaxRateBp: int(c.shippingTaxRateBp, 0, 5000) ?? 1000,
    paymentTimeoutMin: int(c.paymentTimeoutMin, 5, 24 * 60) ?? 30,
  };
}

async function loadOrgSettings(ctx: Ctx) {
  const org = await ctx.trx.selectFrom('organizations').select(['settings', 'timezone']).where('id', '=', ctx.actor.organizationId).executeTakeFirstOrThrow();
  return { settings: commerceSettings(org.settings), timezone: org.timezone };
}

async function nextOrderNumber(ctx: Ctx, timezone: string): Promise<string> {
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric' }).format(new Date());
  const res = await sql<{ value: string | number }>`
    INSERT INTO counters (organization_id, scope, value) VALUES (${ctx.actor.organizationId}, ${`order:${year}`}, 1)
    ON CONFLICT (organization_id, scope) DO UPDATE SET value = counters.value + 1
    RETURNING value`.execute(ctx.trx);
  return `EC${year}-${String(res.rows[0]!.value).padStart(6, '0')}`;
}

interface Line {
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  taxRateBp: number;
  amount: number;
  taxAmount: number;
  stockManaged: boolean;
}

/** 内税: tax per rate on the rate total (shipping included in its rate), allocated back to the lines */
export function computeTotals(lines: Omit<Line, 'taxAmount'>[], shippingFee: number, shippingRateBp: number) {
  const out: Line[] = lines.map((l) => ({ ...l, taxAmount: 0 }));
  const rates = new Set([...out.map((l) => l.taxRateBp), ...(shippingFee > 0 ? [shippingRateBp] : [])]);
  let taxTotal = 0;
  const breakdown: Record<string, { taxable: number; tax: number }> = {};
  for (const rate of rates) {
    const idx = out.map((l, i) => (l.taxRateBp === rate ? i : -1)).filter((i) => i >= 0);
    const amounts = idx.map((i) => out[i]!.amount);
    const ship = rate === shippingRateBp ? shippingFee : 0;
    const taxable = amounts.reduce((a, b) => a + b, 0) + ship;
    const tax = includedTax(taxable, rate);
    taxTotal += tax;
    breakdown[String(rate)] = { taxable, tax };
    const parts = allocate(tax, [...amounts, ship]);
    idx.forEach((i, k) => (out[i]!.taxAmount = parts[k]!));
  }
  const subtotal = out.reduce((a, l) => a + l.amount, 0);
  return { lines: out, subtotal, taxTotal, total: subtotal + shippingFee, breakdown };
}

// ---------------------------------------------------------------- views

const orderColumns = [
  'orders.id',
  'orders.shop_id',
  'orders.customer_id',
  'orders.order_number',
  'orders.channel',
  'orders.status',
  'orders.subtotal',
  'orders.shipping_fee',
  'orders.discount_total',
  'orders.tax_total',
  'orders.total',
  'orders.refunded_amount',
  'orders.shipping_address',
  'orders.contact_email',
  'orders.contact_phone',
  'orders.attributed_staff_id',
  'orders.referral_link_id',
  'orders.is_subscription',
  'orders.carrier',
  'orders.tracking_number',
  'orders.payment_attempts',
  'orders.paid_payment_id',
  'orders.payment_failed_at',
  'orders.expires_at',
  'orders.paid_at',
  'orders.shipped_at',
  'orders.delivered_at',
  'orders.cancelled_at',
  'orders.cancel_reason',
  'orders.note',
  'orders.created_at',
  'orders.updated_at',
] as const;

type OrderRow = Awaited<ReturnType<typeof lockOrder>>;

function lockOrder(ctx: Ctx, id: string) {
  return ctx.trx.selectFrom('orders').select(orderColumns).where('orders.id', '=', id).forUpdate().executeTakeFirst();
}

async function itemsOf(ctx: Ctx, orderIds: string[]) {
  const map = new Map<string, { product_id: string; name: string; unit_price: number; quantity: number; tax_rate_bp: number; tax_amount: number; amount: number }[]>();
  if (!orderIds.length) return map;
  const rows = await ctx.trx
    .selectFrom('order_items')
    .select(['order_id', 'product_id', 'name', 'unit_price', 'quantity', 'tax_rate_bp', 'tax_amount', 'amount'])
    .where('order_id', 'in', orderIds)
    .orderBy('sort_order')
    .orderBy('id')
    .execute();
  for (const { order_id, ...r } of rows) {
    const list = map.get(order_id) ?? [];
    list.push(r);
    map.set(order_id, list);
  }
  return map;
}

function customerView(o: NonNullable<OrderRow>, items: Awaited<ReturnType<typeof itemsOf>> extends Map<string, infer V> ? V : never) {
  return {
    id: o.id,
    orderNumber: o.order_number,
    status: o.status,
    subtotal: o.subtotal,
    shippingFee: o.shipping_fee,
    taxTotal: o.tax_total,
    total: o.total,
    refundedAmount: o.refunded_amount,
    items: items.map((i) => ({ productId: i.product_id, name: i.name, unitPrice: i.unit_price, quantity: i.quantity, taxRateBp: i.tax_rate_bp, amount: i.amount })),
    shippingAddress: o.shipping_address,
    carrier: o.carrier,
    trackingNumber: o.tracking_number,
    paymentFailed: o.status === 'pending' && o.payment_failed_at !== null,
    expiresAt: o.status === 'pending' ? o.expires_at : null,
    createdAt: o.created_at,
    paidAt: o.paid_at,
    shippedAt: o.shipped_at,
    deliveredAt: o.delivered_at,
    cancelledAt: o.cancelled_at,
  };
}

// ---------------------------------------------------------------- create (customer)

async function startPayment(ctx: Ctx, order: { id: string; total: number; order_number: string; customer_id: string | null }, attempt: number) {
  return startOnlinePayment(ctx, {
    orderId: order.id,
    amount: order.total,
    idempotencyKey: `order:${order.id}:${attempt}`,
    description: `ご注文 ${order.order_number}`,
    customerId: order.customer_id,
    metadata: { orderNumber: order.order_number },
  });
}

function paymentView(p: Awaited<ReturnType<typeof startOnlinePayment>> | null) {
  return p ? { paymentId: p.paymentId, status: p.status, provider: p.provider, clientSecret: p.clientSecret } : null;
}

export async function createOrder(ctx: Ctx, shop: PublicShop, input: CreateOrderInput) {
  if (ctx.actor.kind !== 'customer') throw Errors.forbidden('顧客認証が必要です');
  const customerId = ctx.actor.customerId;

  // idempotent replay (same customer + key)
  const existing = await ctx.trx.selectFrom('orders').select(orderColumns).where('orders.customer_id', '=', customerId).where('orders.idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
  if (existing) {
    const payment = existing.status === 'pending' && existing.payment_attempts > 0 ? await startPayment(ctx, existing, existing.payment_attempts) : null;
    return { order: customerView(existing, (await itemsOf(ctx, [existing.id])).get(existing.id) ?? []), payment: paymentView(payment), replayed: true };
  }

  const customer = await ctx.trx.selectFrom('customers').select(['id', 'email', 'status', 'deleted_at']).where('id', '=', customerId).executeTakeFirst();
  if (!customer || customer.deleted_at || customer.status !== 'active') throw Errors.unauthenticated();

  // merge duplicate product lines
  const qty = new Map<string, number>();
  for (const i of input.items) qty.set(i.productId, (qty.get(i.productId) ?? 0) + i.quantity);
  const products = await ctx.trx
    .selectFrom('products')
    .select(['id', 'shop_id', 'name', 'price', 'price_tax_included', 'tax_rate_bp', 'is_online', 'status', 'stock_managed'])
    .where('id', 'in', [...qty.keys()])
    .where('deleted_at', 'is', null)
    .execute();
  const byId = new Map(products.map((p) => [p.id, p]));
  const lines: Omit<Line, 'taxAmount'>[] = [];
  for (const [productId, quantity] of qty) {
    const p = byId.get(productId);
    if (!p || !p.is_online || p.status !== 'active' || (p.shop_id && p.shop_id !== shop.shopId)) {
      throw Errors.business('PRODUCT_UNAVAILABLE', 'ご注文いただけない商品が含まれています', { productId });
    }
    if (quantity > 99) throw Errors.validation('1商品あたりの数量は99個までです');
    const unit = inclusivePrice(p);
    lines.push({ productId, name: p.name, unitPrice: unit, quantity, taxRateBp: p.tax_rate_bp, amount: unit * quantity, stockManaged: p.stock_managed });
  }

  const { settings, timezone } = await loadOrgSettings(ctx);
  const itemSubtotal = lines.reduce((a, l) => a + l.amount, 0);
  const shippingFee = settings.freeShippingThreshold !== null && itemSubtotal >= settings.freeShippingThreshold ? 0 : settings.shippingFee;
  const totals = computeTotals(lines, shippingFee, settings.shippingTaxRateBp);

  const link = await resolveReferralCode(ctx, input.referralCode, { activeOnly: true });
  const orderNumber = await nextOrderNumber(ctx, timezone);
  const expiresAt = new Date(Date.now() + settings.paymentTimeoutMin * 60_000);
  const addr = input.shippingAddress;
  const inserted = await ctx.trx
    .insertInto('orders')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: shop.shopId,
      customer_id: customerId,
      order_number: orderNumber,
      channel: input.channel,
      status: 'pending',
      subtotal: totals.subtotal,
      shipping_fee: shippingFee,
      tax_total: totals.taxTotal,
      total: totals.total,
      shipping_address: JSON.stringify({ ...addr, postalCode: addr.postalCode.replace(/^(\d{3})-?(\d{4})$/, '$1-$2') }),
      contact_email: input.contactEmail ?? customer.email ?? null,
      contact_phone: addr.phone,
      attributed_staff_id: link?.staff_id ?? null,
      referral_link_id: link?.id ?? null,
      note: input.note ?? null,
      idempotency_key: input.idempotencyKey,
      expires_at: expiresAt,
      trace_id: ctx.meta.traceId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const order = (await lockOrder(ctx, inserted.id))!;

  await ctx.trx
    .insertInto('order_items')
    .values(
      totals.lines.map((l, i) => ({
        organization_id: ctx.actor.organizationId,
        sort_order: i,
        order_id: order.id,
        product_id: l.productId,
        name: l.name,
        unit_price: l.unitPrice,
        quantity: l.quantity,
        tax_rate_bp: l.taxRateBp,
        tax_amount: l.taxAmount,
        amount: l.amount,
      })),
    )
    .execute();

  // reserve EC-warehouse stock (fails the whole order on shortage)
  for (const l of totals.lines) {
    if (!l.stockManaged) continue;
    await applyStockMovement(ctx, { productId: l.productId, shopId: null, delta: -l.quantity, reason: 'order', orderId: order.id, productName: l.name });
  }

  let payment: Awaited<ReturnType<typeof startOnlinePayment>> | null = null;
  if (order.total > 0) {
    payment = await startPayment(ctx, order, 1);
    await ctx.trx.updateTable('orders').set({ payment_attempts: 1 }).where('id', '=', order.id).execute();
    await enqueue(ctx, { type: 'commerce.expire_order', payload: { orderId: order.id }, runAt: expiresAt, dedupeKey: `order-expire:${order.id}` });
  } else {
    await markPaid(ctx, order, null);
  }
  await audit(ctx, { action: 'order.create', resourceType: 'order', resourceId: order.id, shopId: shop.shopId, after: { orderNumber, total: totals.total, items: [...qty.entries()] } });
  const fresh = (await lockOrder(ctx, order.id))!;
  return { order: customerView(fresh, (await itemsOf(ctx, [order.id])).get(order.id) ?? []), payment: paymentView(payment), replayed: false };
}

/** Retry payment for a pending order after a failed attempt (or re-fetch the current client secret) */
export async function retryOrderPayment(ctx: Ctx, customerId: string, orderId: string) {
  const o = await lockOrder(ctx, orderId);
  if (!o || o.customer_id !== customerId) throw Errors.notFound('注文', orderId);
  if (o.status !== 'pending') throw Errors.business('ORDER_NOT_PAYABLE', 'この注文はお支払い手続きできません');
  if (o.expires_at && o.expires_at <= new Date()) throw Errors.business('ORDER_EXPIRED', 'お支払い期限を過ぎています。もう一度ご注文ください');
  let attempt = Math.max(1, o.payment_attempts);
  if (o.payment_failed_at || o.payment_attempts === 0) {
    attempt = o.payment_attempts + 1;
    await ctx.trx.updateTable('orders').set({ payment_attempts: attempt, payment_failed_at: null }).where('id', '=', o.id).execute();
  }
  const payment = await startPayment(ctx, o, attempt);
  return { orderId: o.id, payment: paymentView(payment) };
}

// ---------------------------------------------------------------- payment events

async function markPaid(ctx: Ctx, o: NonNullable<OrderRow>, paymentId: string | null) {
  const now = new Date();
  await ctx.trx.updateTable('orders').set({ status: 'paid', paid_at: now, paid_payment_id: paymentId, payment_failed_at: null }).where('id', '=', o.id).execute();
  await cancelJobs(ctx.trx, `order-expire:${o.id}`);
  await emit(ctx, {
    type: 'order.paid',
    aggregateType: 'order',
    aggregateId: o.id,
    payload: { orderId: o.id, customerId: o.customer_id, total: o.total, shopId: o.shop_id, referralLinkId: o.referral_link_id, attributedStaffId: o.attributed_staff_id },
  });
  if (o.customer_id) {
    await queueMessage(ctx, {
      customerId: o.customer_id,
      shopId: o.shop_id,
      category: 'transactional',
      templateKey: 'order_paid',
      vars: { order: { number: o.order_number, total: o.total } },
      dedupeKey: `order-paid:${o.id}`,
    });
  }
}

export async function onPaymentSucceeded(ctx: Ctx, p: { paymentId: string; orderId: string | null; amount: number }) {
  if (!p.orderId) return;
  const o = await lockOrder(ctx, p.orderId);
  if (!o) return;
  if (o.status === 'pending') {
    await markPaid(ctx, o, p.paymentId);
    return;
  }
  if (o.paid_payment_id !== p.paymentId) {
    // money arrived for an order that already expired/was cancelled, or a duplicate attempt → refund it
    await enqueue(ctx, { type: 'commerce.refund_orphan_payment', payload: { paymentId: p.paymentId, orderId: o.id, amount: p.amount }, dedupeKey: `order-orphan-refund:${p.paymentId}` });
  }
}

export async function onPaymentFailed(ctx: Ctx, p: { paymentId: string; orderId: string | null }) {
  if (!p.orderId) return;
  // keep the order (and its stock reservation) pending so the customer can retry until expires_at
  await ctx.trx.updateTable('orders').set({ payment_failed_at: new Date() }).where('id', '=', p.orderId).where('status', '=', 'pending').execute();
}

export async function onPaymentRefunded(ctx: Ctx, p: { paymentId: string; orderId: string | null; refundedAmount?: number }) {
  if (!p.orderId || p.refundedAmount === undefined) return;
  await ctx.trx
    .updateTable('orders')
    .set({ refunded_amount: p.refundedAmount })
    .where('id', '=', p.orderId)
    .where('paid_payment_id', '=', p.paymentId)
    .execute();
}

export async function refundOrphanPayment(ctx: Ctx, p: { paymentId: string; orderId: string; amount: number }) {
  await refundPayment(ctx, { paymentId: p.paymentId, amount: p.amount, reason: '注文の期限切れ・重複決済のため自動返金', idempotencyKey: `order-orphan:${p.paymentId}` });
  await audit(ctx, { action: 'order.orphan_refund', resourceType: 'order', resourceId: p.orderId, metadata: { paymentId: p.paymentId, amount: p.amount } });
}

// ---------------------------------------------------------------- cancel / expire

async function releaseReservation(ctx: Ctx, orderId: string) {
  const reserved = await ctx.trx
    .selectFrom('stock_movements')
    .select(['product_id', 'shop_id', (eb) => eb.fn.sum<number>('delta').as('net')])
    .where('order_id', '=', orderId)
    .groupBy(['product_id', 'shop_id'])
    .execute();
  for (const r of reserved) {
    const net = Number(r.net);
    if (net < 0) await applyStockMovement(ctx, { productId: r.product_id, shopId: r.shop_id, delta: -net, reason: 'cancel', orderId });
  }
}

async function cancelInternal(ctx: Ctx, o: NonNullable<OrderRow>, reason: string) {
  let refunded = o.refunded_amount;
  if (['paid', 'processing'].includes(o.status) && o.paid_payment_id && o.total - o.refunded_amount > 0) {
    await refundPayment(ctx, { paymentId: o.paid_payment_id, amount: o.total - o.refunded_amount, reason, idempotencyKey: `order-cancel:${o.id}` });
    refunded = o.total;
  }
  await releaseReservation(ctx, o.id);
  const now = new Date();
  await ctx.trx
    .updateTable('orders')
    .set({ status: 'cancelled', cancelled_at: now, cancel_reason: reason, stock_released_at: now, refunded_amount: refunded })
    .where('id', '=', o.id)
    .execute();
  await cancelJobs(ctx.trx, `order-expire:${o.id}`);
  await emit(ctx, { type: 'order.cancelled', aggregateType: 'order', aggregateId: o.id, payload: { orderId: o.id, customerId: o.customer_id, total: o.total, refundedAmount: refunded, reason } });
  if (o.customer_id) {
    await queueMessage(ctx, {
      customerId: o.customer_id,
      shopId: o.shop_id,
      category: 'transactional',
      templateKey: 'order_cancelled',
      vars: { order: { number: o.order_number, total: o.total, refundedAmount: refunded, cancelReason: reason } },
      dedupeKey: `order-cancelled:${o.id}`,
    });
  }
  return refunded;
}

/** Delayed job: cancel orders still unpaid at expires_at and release their stock */
export async function expireOrder(ctx: Ctx, orderId: string) {
  const o = await lockOrder(ctx, orderId);
  if (!o || o.status !== 'pending') return false;
  if (o.expires_at && o.expires_at > new Date()) {
    // distinct key: the running job still holds `order-expire:<id>` (cancelJobs matches by prefix)
    await enqueue(ctx, { type: 'commerce.expire_order', payload: { orderId }, runAt: o.expires_at, dedupeKey: `order-expire:${orderId}:${o.expires_at.getTime()}` });
    return false;
  }
  await cancelInternal(ctx, o, 'お支払いが確認できなかったため自動キャンセルしました');
  return true;
}

// ---------------------------------------------------------------- staff management

async function loadForStaff(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'order.manage');
  const o = await lockOrder(ctx, id);
  if (!o) throw Errors.notFound('注文', id);
  assertShopAccess(ctx.actor, o.shop_id);
  return o;
}

export async function listOrders(ctx: Ctx, input: ListOrdersInput) {
  requirePermission(ctx.actor, 'order.manage');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  let q = ctx.trx
    .selectFrom('orders')
    .leftJoin('customers', 'customers.id', 'orders.customer_id')
    .select(orderColumns)
    .select(['customers.last_name', 'customers.first_name', 'customers.last_name_kana', 'customers.first_name_kana']);
  const shops = accessibleShopIds(ctx.actor);
  if (shops) q = q.where((eb) => eb.or([eb('orders.shop_id', 'is', null), eb('orders.shop_id', 'in', shops.length ? [...shops] : [NO_SHOP])]));
  if (input.status) q = q.where('orders.status', '=', input.status);
  if (input.customerId) q = q.where('orders.customer_id', '=', input.customerId);
  if (input.shopId) q = q.where('orders.shop_id', '=', input.shopId);
  if (input.from || input.to) {
    const { timezone } = await loadOrgSettings(ctx);
    if (input.from) q = q.where('orders.created_at', '>=', dayBounds(input.from, timezone).start);
    if (input.to) q = q.where('orders.created_at', '<', dayBounds(input.to, timezone).end);
  }
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql`(orders.created_at, orders.id)`, '<', sql`(${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('orders.created_at', 'desc').orderBy('orders.id', 'desc').limit(input.limit + 1).execute();
  const page = paginate(rows, input.limit, (r) => r.created_at);
  const showCustomer = can(ctx.actor, 'customer.read');
  return {
    items: page.items.map(({ last_name, first_name, last_name_kana, first_name_kana, ...o }) => ({
      ...o,
      customer_name: showCustomer && o.customer_id ? displayName({ last_name: last_name ?? '', first_name: first_name ?? '', last_name_kana: last_name_kana ?? '', first_name_kana: first_name_kana ?? '' }) : null,
    })),
    nextCursor: page.nextCursor,
  };
}

export async function getOrder(ctx: Ctx, id: string) {
  const o = await loadForStaff(ctx, id);
  const [items, payments, staff, customer] = await Promise.all([
    itemsOf(ctx, [id]),
    ctx.trx.selectFrom('payments').select(['id', 'method', 'provider', 'amount', 'refunded_amount', 'status', 'failure_code', 'created_at']).where('order_id', '=', id).orderBy('created_at').execute(),
    o.attributed_staff_id ? ctx.trx.selectFrom('staffs').select(['id', 'display_name']).where('id', '=', o.attributed_staff_id).executeTakeFirst() : undefined,
    o.customer_id && can(ctx.actor, 'customer.read')
      ? ctx.trx.selectFrom('customers').select(['id', 'last_name', 'first_name', 'last_name_kana', 'first_name_kana']).where('id', '=', o.customer_id).executeTakeFirst()
      : undefined,
  ]);
  await audit(ctx, { action: 'order.view', resourceType: 'order', resourceId: id, shopId: o.shop_id });
  return {
    ...o,
    items: items.get(id) ?? [],
    payments,
    attributed_staff: staff ?? null,
    customer: customer ? { id: customer.id, display_name: displayName(customer) } : null,
  };
}

export async function processOrder(ctx: Ctx, id: string) {
  const o = await loadForStaff(ctx, id);
  if (o.status !== 'paid') throw Errors.business('INVALID_ORDER_TRANSITION', '支払済の注文のみ出荷準備中にできます', { from: o.status });
  await ctx.trx.updateTable('orders').set({ status: 'processing' }).where('id', '=', id).execute();
  await audit(ctx, { action: 'order.process', resourceType: 'order', resourceId: id, shopId: o.shop_id, before: { status: o.status }, after: { status: 'processing' } });
  return getOrder(ctx, id);
}

export async function shipOrder(ctx: Ctx, id: string, input: { carrier: string; trackingNumber: string }) {
  const o = await loadForStaff(ctx, id);
  if (!['paid', 'processing'].includes(o.status)) throw Errors.business('INVALID_ORDER_TRANSITION', '支払済の注文のみ発送できます', { from: o.status });
  await ctx.trx.updateTable('orders').set({ status: 'shipped', shipped_at: new Date(), carrier: input.carrier, tracking_number: input.trackingNumber }).where('id', '=', id).execute();
  await emit(ctx, { type: 'order.shipped', aggregateType: 'order', aggregateId: id, payload: { orderId: id, customerId: o.customer_id, total: o.total, carrier: input.carrier, trackingNumber: input.trackingNumber } });
  if (o.customer_id) {
    await queueMessage(ctx, {
      customerId: o.customer_id,
      shopId: o.shop_id,
      category: 'transactional',
      templateKey: 'order_shipped',
      vars: { order: { number: o.order_number, total: o.total }, shipping: { carrier: input.carrier, trackingNumber: input.trackingNumber } },
      dedupeKey: `order-shipped:${id}`,
    });
  }
  await audit(ctx, { action: 'order.ship', resourceType: 'order', resourceId: id, shopId: o.shop_id, before: { status: o.status }, after: { status: 'shipped', ...input } });
  return getOrder(ctx, id);
}

export async function deliverOrder(ctx: Ctx, id: string) {
  const o = await loadForStaff(ctx, id);
  if (o.status !== 'shipped') throw Errors.business('INVALID_ORDER_TRANSITION', '発送済の注文のみ配達完了にできます', { from: o.status });
  await ctx.trx.updateTable('orders').set({ status: 'delivered', delivered_at: new Date() }).where('id', '=', id).execute();
  await audit(ctx, { action: 'order.deliver', resourceType: 'order', resourceId: id, shopId: o.shop_id, before: { status: o.status }, after: { status: 'delivered' } });
  return getOrder(ctx, id);
}

export async function cancelOrder(ctx: Ctx, id: string, reason: string) {
  const o = await loadForStaff(ctx, id);
  if (['shipped', 'delivered'].includes(o.status)) throw Errors.business('ORDER_ALREADY_SHIPPED', '発送済の注文はキャンセルできません（返品として対応してください）');
  if (['cancelled', 'refunded'].includes(o.status)) throw Errors.business('ORDER_ALREADY_CANCELLED', 'この注文は既にキャンセルされています');
  const refunded = await cancelInternal(ctx, o, reason);
  await audit(ctx, { action: 'order.cancel', resourceType: 'order', resourceId: id, shopId: o.shop_id, before: { status: o.status }, after: { status: 'cancelled', reason, refunded } });
  return getOrder(ctx, id);
}

// ---------------------------------------------------------------- customer self-service

export async function listMyOrders(ctx: Ctx, customerId: string) {
  const rows = await ctx.trx.selectFrom('orders').select(orderColumns).where('orders.customer_id', '=', customerId).orderBy('orders.created_at', 'desc').limit(50).execute();
  const items = await itemsOf(ctx, rows.map((r) => r.id));
  return rows.map((o) => customerView(o, items.get(o.id) ?? []));
}

export async function getMyOrder(ctx: Ctx, customerId: string, id: string) {
  const o = await ctx.trx.selectFrom('orders').select(orderColumns).where('orders.id', '=', id).executeTakeFirst();
  if (!o || o.customer_id !== customerId) throw Errors.notFound('注文', id);
  return customerView(o, (await itemsOf(ctx, [id])).get(id) ?? []);
}
