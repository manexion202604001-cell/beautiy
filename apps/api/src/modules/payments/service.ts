import { accessibleShopIds, assertShopAccess, requireAnyPermission, requirePermission, type Ctx } from '../../auth/actor.js';
import { config } from '../../config.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { outstandingBalance, refundPayment, settleOnlinePayment, startOnlinePayment } from './api.js';
import type { CreateCustomMethodInput, RefundRequestInput, StartPaymentInput, UpdateCustomMethodInput } from './schemas.js';

function requireKey(bodyKey: string | undefined, headerKey: string | undefined): string {
  const key = (bodyKey ?? headerKey ?? '').trim();
  if (!key) throw Errors.validation('idempotencyKey(またはIdempotency-Keyヘッダー)が必要です');
  if (key.length > 255) throw Errors.validation('idempotencyKeyが長すぎます');
  return key;
}

/** Authorize access to the transaction/order a payment belongs to */
async function authorizeTarget(ctx: Ctx, target: { transactionId?: string | null; orderId?: string | null }, txPermission: 'pos.read' | 'pos.operate' | 'pos.refund') {
  if (target.transactionId) {
    requirePermission(ctx.actor, txPermission);
    const tx = await ctx.trx.selectFrom('transactions').select(['id', 'shop_id', 'status', 'customer_id']).where('id', '=', target.transactionId).executeTakeFirst();
    if (!tx) throw Errors.notFound('会計', target.transactionId);
    assertShopAccess(ctx.actor, tx.shop_id);
    return { shopId: tx.shop_id as string | null, customerId: tx.customer_id };
  }
  if (target.orderId) {
    // EC orders: managed by order staff; refunds also allowed with the POS refund permission
    if (txPermission === 'pos.refund') requireAnyPermission(ctx.actor, 'order.manage', 'pos.refund');
    else requirePermission(ctx.actor, 'order.manage');
    const o = await ctx.trx.selectFrom('orders').select(['id', 'shop_id', 'customer_id']).where('id', '=', target.orderId).executeTakeFirst();
    if (!o) throw Errors.notFound('注文', target.orderId);
    if (o.shop_id) assertShopAccess(ctx.actor, o.shop_id);
    return { shopId: o.shop_id, customerId: o.customer_id };
  }
  throw Errors.validation('決済の紐付け先がありません');
}

function present(p: Record<string, any>, refunds: Record<string, any>[] = []) {
  return {
    id: p.id,
    transaction_id: p.transaction_id,
    order_id: p.order_id,
    method: p.method,
    custom_method_id: p.custom_method_id,
    provider: p.provider,
    provider_payment_id: p.provider_payment_id,
    amount: p.amount,
    tendered_amount: p.tendered_amount,
    change_amount: p.change_amount,
    refunded_amount: p.refunded_amount,
    status: p.status,
    // only expose the client secret while the payer still has to act
    client_secret: ['pending', 'requires_action'].includes(p.status) ? p.client_secret : null,
    failure_code: p.failure_code,
    failure_reason: p.failure_reason,
    succeeded_at: p.succeeded_at,
    created_at: p.created_at,
    updated_at: p.updated_at,
    refunds: refunds.map((r) => ({ id: r.id, amount: r.amount, reason: r.reason, status: r.status, provider_refund_id: r.provider_refund_id, created_at: r.created_at })),
  };
}

export async function getPayment(ctx: Ctx, paymentId: string) {
  const p = await ctx.trx.selectFrom('payments').selectAll().where('id', '=', paymentId).executeTakeFirst();
  if (!p) throw Errors.notFound('決済', paymentId);
  await authorizeTarget(ctx, { transactionId: p.transaction_id, orderId: p.order_id }, 'pos.read');
  const refunds = await ctx.trx.selectFrom('refunds').selectAll().where('payment_id', '=', paymentId).orderBy('created_at').execute();
  return present(p, refunds);
}

export async function startPayment(ctx: Ctx, input: StartPaymentInput, headerKey?: string) {
  const key = requireKey(input.idempotencyKey, headerKey);
  const target = await authorizeTarget(ctx, input, 'pos.operate');
  // replay first so a retried request is not rejected by the (now smaller) balance
  const existing = await ctx.trx.selectFrom('payments').select(['id', 'amount']).where('idempotency_key', '=', key).executeTakeFirst();
  let amount = input.amount ?? existing?.amount;
  if (amount === undefined) {
    const bal = await outstandingBalance(ctx, input);
    if (input.transactionId && bal.status !== 'draft') throw Errors.business('TRANSACTION_NOT_DRAFT', '確定済みまたは取消済みの会計には決済できません');
    if (input.orderId && bal.status !== 'pending') throw Errors.business('ORDER_NOT_PAYABLE', 'この注文は決済できる状態ではありません');
    if (bal.outstanding <= 0) throw Errors.business('NOTHING_TO_PAY', '未払い残高がありません');
    amount = bal.outstanding;
  }
  const result = await startOnlinePayment(ctx, {
    transactionId: input.transactionId,
    orderId: input.orderId,
    amount,
    idempotencyKey: key,
    description: input.description,
    customerId: target.customerId,
  });
  const p = await ctx.trx.selectFrom('payments').selectAll().where('id', '=', result.paymentId).executeTakeFirstOrThrow();
  return { ...present(p), replayed: result.replayed, client_secret: result.clientSecret && ['pending', 'requires_action'].includes(p.status) ? result.clientSecret : null };
}

export async function refundPaymentRequest(ctx: Ctx, paymentId: string, input: RefundRequestInput, headerKey?: string) {
  const key = requireKey(input.idempotencyKey, headerKey);
  const p = await ctx.trx.selectFrom('payments').selectAll().where('id', '=', paymentId).executeTakeFirst();
  if (!p) throw Errors.notFound('決済', paymentId);
  const target = await authorizeTarget(ctx, { transactionId: p.transaction_id, orderId: p.order_id }, 'pos.refund');
  const replay = await ctx.trx.selectFrom('refunds').select(['amount']).where('idempotency_key', '=', key).executeTakeFirst();
  const amount = input.amount ?? replay?.amount ?? p.amount - p.refunded_amount;
  if (p.method === 'point') throw Errors.business('PAYMENT_NOT_REFUNDABLE', 'ポイント支払いは会計の返金から処理してください');
  let registerSessionId: string | null = null;
  if (p.method === 'cash' && target.shopId) {
    const s = await ctx.trx.selectFrom('register_sessions').select('id').where('shop_id', '=', target.shopId).where('status', '=', 'open').executeTakeFirst();
    registerSessionId = s?.id ?? null;
  }
  await refundPayment(ctx, { paymentId, amount, reason: input.reason, idempotencyKey: key, registerSessionId });
  return getPayment(ctx, paymentId);
}

/** Dev/test only: simulate the provider callback for a mock payment */
export async function mockComplete(ctx: Ctx, paymentId: string, input: { success: boolean; failureCode?: string; failureReason?: string }) {
  if (config.PAYMENT_PROVIDER !== 'mock') throw Errors.notFound('リソース');
  const p = await ctx.trx.selectFrom('payments').selectAll().where('id', '=', paymentId).executeTakeFirst();
  if (!p) throw Errors.notFound('決済', paymentId);
  await authorizeTarget(ctx, { transactionId: p.transaction_id, orderId: p.order_id }, 'pos.operate');
  if (p.provider !== 'mock') throw Errors.business('NOT_MOCK_PAYMENT', 'モック決済ではありません');
  await settleOnlinePayment(ctx, paymentId, { success: input.success, failureCode: input.success ? undefined : (input.failureCode ?? 'card_declined'), failureReason: input.failureReason });
  return getPayment(ctx, paymentId);
}

// ---------------------------------------------------------------------------------------------
// 店舗独自決済 (custom payment methods: 回数券 / 商品券 ...)
// ---------------------------------------------------------------------------------------------

export async function listCustomMethods(ctx: Ctx, input: { shopId?: string; includeInactive?: boolean }) {
  requirePermission(ctx.actor, 'pos.read');
  let q = ctx.trx.selectFrom('custom_payment_methods').selectAll().orderBy('created_at');
  if (input.shopId) {
    assertShopAccess(ctx.actor, input.shopId);
    q = q.where((eb) => eb.or([eb('shop_id', 'is', null), eb('shop_id', '=', input.shopId!)]));
  } else {
    const ids = accessibleShopIds(ctx.actor);
    if (ids) q = q.where((eb) => eb.or([eb('shop_id', 'is', null), eb('shop_id', 'in', ids.length ? [...ids] : ['00000000-0000-0000-0000-000000000000'])]));
  }
  if (!input.includeInactive) q = q.where('is_active', '=', true);
  return q.execute();
}

async function loadCustomMethod(ctx: Ctx, id: string) {
  const m = await ctx.trx.selectFrom('custom_payment_methods').selectAll().where('id', '=', id).executeTakeFirst();
  if (!m) throw Errors.notFound('店舗独自決済', id);
  return m;
}

export async function createCustomMethod(ctx: Ctx, input: CreateCustomMethodInput) {
  requirePermission(ctx.actor, 'shop.manage');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  else if (accessibleShopIds(ctx.actor) !== null) throw Errors.forbidden('法人共通の決済方法は全店舗権限が必要です');
  const row = await ctx.trx
    .insertInto('custom_payment_methods')
    .values({ organization_id: ctx.actor.organizationId, shop_id: input.shopId ?? null, name: input.name, counts_as_sales: input.countsAsSales })
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'payment_method.create', resourceType: 'custom_payment_method', resourceId: row.id, shopId: row.shop_id, after: row });
  return row;
}

export async function updateCustomMethod(ctx: Ctx, id: string, input: UpdateCustomMethodInput) {
  requirePermission(ctx.actor, 'shop.manage');
  const before = await loadCustomMethod(ctx, id);
  if (before.shop_id) assertShopAccess(ctx.actor, before.shop_id);
  else if (accessibleShopIds(ctx.actor) !== null) throw Errors.forbidden('法人共通の決済方法は全店舗権限が必要です');
  const after = await ctx.trx
    .updateTable('custom_payment_methods')
    .set({ name: input.name, is_active: input.isActive, counts_as_sales: input.countsAsSales })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'payment_method.update', resourceType: 'custom_payment_method', resourceId: id, shopId: before.shop_id, before, after });
  return after;
}

/** Deletes an unused method; a method referenced by payments is deactivated instead (history stays intact) */
export async function deleteCustomMethod(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'shop.manage');
  const before = await loadCustomMethod(ctx, id);
  if (before.shop_id) assertShopAccess(ctx.actor, before.shop_id);
  else if (accessibleShopIds(ctx.actor) !== null) throw Errors.forbidden('法人共通の決済方法は全店舗権限が必要です');
  const used = await ctx.trx.selectFrom('payments').select('id').where('custom_method_id', '=', id).limit(1).executeTakeFirst();
  if (used) await ctx.trx.updateTable('custom_payment_methods').set({ is_active: false }).where('id', '=', id).execute();
  else await ctx.trx.deleteFrom('custom_payment_methods').where('id', '=', id).execute();
  await audit(ctx, { action: 'payment_method.delete', resourceType: 'custom_payment_method', resourceId: id, shopId: before.shop_id, before, metadata: { deactivated: !!used } });
  return { deactivated: !!used };
}
