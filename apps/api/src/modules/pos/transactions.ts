import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { accessibleShopIds, assertShopAccess, auditUserId, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { emit } from '../../lib/events.js';
import { toInclusive } from '../../lib/money.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { addDays, dayBounds, localDate } from '../../lib/time.js';
import { transitionAppointment } from '../appointments/service.js';
import { effectiveMenus, evaluateCoupon } from '../catalog/service.js';
import { assertCustomerAccess } from '../customers/access.js';
import { ensureVisitedRelation } from '../customers/service.js';
import { recomputeCustomerStats } from '../customers/stats.js';
import { cancelPayment, outstandingBalance, recordOfflinePayment, refundPayment, startOnlinePayment } from '../payments/api.js';
import { allocateStaff, calculate, pointsFor, type CalcDiscount, type CalcLine, type StaffShare } from './calc.js';
import { CAPTURED, findOpenSession, formatNumber, loadPosShop, localYear, nextCounter, SOLD_STATUSES } from './common.js';
import { applyPoints, ledgerSum } from './points.js';
import type { AddPaymentInput, CreateTransactionInput, ItemInput, ListTransactionsInput, RefundTransactionInput, ReplaceItemsInput } from './schemas.js';
import { adjustStock } from './stock.js';

type ItemType = 'service' | 'product' | 'nomination_fee' | 'discount' | 'coupon' | 'adjustment';

async function lockTx(ctx: Ctx, id: string) {
  const tx = await ctx.trx.selectFrom('transactions').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  if (!tx) throw Errors.notFound('会計', id);
  assertShopAccess(ctx.actor, tx.shop_id);
  return tx;
}
type TxRow = Awaited<ReturnType<typeof lockTx>>;

function requireKey(bodyKey: string | undefined, headerKey: string | undefined): string {
  const key = (bodyKey ?? headerKey ?? '').trim();
  if (!key) throw Errors.validation('idempotencyKey(またはIdempotency-Keyヘッダー)が必要です');
  if (key.length > 200) throw Errors.validation('idempotencyKeyが長すぎます');
  return key;
}

function requireDraft(tx: TxRow) {
  if (tx.status !== 'draft') throw Errors.business('TRANSACTION_NOT_DRAFT', '確定済みまたは取消済みの会計は変更できません', { status: tx.status });
}

// =============================================================================================
// Read
// =============================================================================================

export async function getTransactionUnchecked(ctx: Ctx, id: string) {
  const tx = await ctx.trx
    .selectFrom('transactions as t')
    .leftJoin('customers as c', 'c.id', 't.customer_id')
    .leftJoin('staffs as s', 's.id', 't.staff_id')
    .selectAll('t')
    .select([
      sql<string | null>`CASE WHEN c.id IS NULL THEN NULL ELSE trim(c.last_name || ' ' || c.first_name) END`.as('customer_name'),
      'c.point_balance as customer_point_balance',
      's.display_name as staff_name',
    ])
    .where('t.id', '=', id)
    .executeTakeFirst();
  if (!tx) throw Errors.notFound('会計', id);
  const [items, staff, payments, refunds, receipts] = await Promise.all([
    ctx.trx.selectFrom('transaction_items').selectAll().where('transaction_id', '=', id).orderBy('sort_order').execute(),
    ctx.trx
      .selectFrom('transaction_item_staff as tis')
      .innerJoin('transaction_items as ti', 'ti.id', 'tis.transaction_item_id')
      .innerJoin('staffs as s', 's.id', 'tis.staff_id')
      .select(['tis.id', 'tis.transaction_item_id', 'tis.staff_id', 's.display_name as staff_name', 'tis.role', 'tis.share_bp', 'tis.is_nominated', 'tis.allocated_amount'])
      .where('ti.transaction_id', '=', id)
      .execute(),
    ctx.trx
      .selectFrom('payments as p')
      .leftJoin('custom_payment_methods as cm', 'cm.id', 'p.custom_method_id')
      .select([
        'p.id',
        'p.method',
        'p.custom_method_id',
        'cm.name as custom_method_name',
        'p.provider',
        'p.provider_payment_id',
        'p.amount',
        'p.tendered_amount',
        'p.change_amount',
        'p.refunded_amount',
        'p.status',
        'p.client_secret',
        'p.failure_code',
        'p.succeeded_at',
        'p.created_at',
      ])
      .where('p.transaction_id', '=', id)
      .orderBy('p.created_at')
      .execute(),
    ctx.trx
      .selectFrom('refunds as r')
      .innerJoin('payments as p', 'p.id', 'r.payment_id')
      .select(['r.id', 'r.payment_id', 'p.method', 'r.amount', 'r.reason', 'r.status', 'r.created_at'])
      .where('p.transaction_id', '=', id)
      .orderBy('r.created_at')
      .execute(),
    ctx.trx.selectFrom('receipts').select(['id', 'receipt_number', 'receipt_type', 'addressee', 'reissue_of', 'issued_at']).where('transaction_id', '=', id).orderBy('issued_at').execute(),
  ]);
  return {
    ...tx,
    items: items.map((i) => ({ ...i, staff: staff.filter((s) => s.transaction_item_id === i.id).map(({ transaction_item_id: _x, ...s }) => s) })),
    payments: payments.map((p) => ({ ...p, client_secret: ['pending', 'requires_action'].includes(p.status) ? p.client_secret : null })),
    refunds,
    receipts,
    outstanding: tx.status === 'draft' ? tx.total - payments.filter((p) => ['pending', 'requires_action', ...CAPTURED].includes(p.status)).reduce((s, p) => s + p.amount - p.refunded_amount, 0) : 0,
  };
}

export async function getTransaction(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'pos.read');
  const tx = await getTransactionUnchecked(ctx, id);
  assertShopAccess(ctx.actor, tx.shop_id);
  return tx;
}

export function txFilters(ctx: Ctx, input: Omit<ListTransactionsInput, 'cursor' | 'limit'>, tz: string) {
  return <Q extends { where: (...args: any[]) => Q }>(qb: Q): Q => {
    let q: any = qb;
    if (input.shopId) q = q.where('t.shop_id', '=', input.shopId);
    else {
      const ids = accessibleShopIds(ctx.actor);
      if (ids) q = q.where('t.shop_id', 'in', ids.length ? [...ids] : ['00000000-0000-0000-0000-000000000000']);
    }
    if (input.from) q = q.where(sql`coalesce(t.completed_at, t.created_at)`, '>=', dayBounds(input.from, tz).start);
    if (input.to) q = q.where(sql`coalesce(t.completed_at, t.created_at)`, '<', dayBounds(input.to, tz).end);
    if (input.status) q = q.where('t.status', 'in', Array.isArray(input.status) ? input.status : [input.status]);
    if (input.customerId) q = q.where('t.customer_id', '=', input.customerId);
    if (input.staffId) {
      const sid = input.staffId;
      q = q.where((eb: any) =>
        eb.or([
          eb('t.staff_id', '=', sid),
          eb.exists(
            eb
              .selectFrom('transaction_item_staff as tis')
              .innerJoin('transaction_items as ti', 'ti.id', 'tis.transaction_item_id')
              .select(sql`1`.as('x'))
              .whereRef('ti.transaction_id', '=', 't.id')
              .where('tis.staff_id', '=', sid),
          ),
        ]),
      );
    }
    return q as Q;
  };
}

export async function filterTz(ctx: Ctx, shopId?: string): Promise<string> {
  if (!shopId) return 'Asia/Tokyo';
  assertShopAccess(ctx.actor, shopId);
  return (await loadPosShop(ctx, shopId)).timezone;
}

export async function listTransactions(ctx: Ctx, input: ListTransactionsInput) {
  requirePermission(ctx.actor, 'pos.read');
  const tz = await filterTz(ctx, input.shopId);
  let q = ctx.trx
    .selectFrom('transactions as t')
    .leftJoin('customers as c', 'c.id', 't.customer_id')
    .leftJoin('staffs as s', 's.id', 't.staff_id')
    .select([
      't.id',
      't.shop_id',
      't.transaction_number',
      't.status',
      't.appointment_id',
      't.customer_id',
      sql<string | null>`CASE WHEN c.id IS NULL THEN NULL ELSE trim(c.last_name || ' ' || c.first_name) END`.as('customer_name'),
      't.staff_id',
      's.display_name as staff_name',
      't.is_nominated',
      't.subtotal',
      't.discount_total',
      't.tax_total',
      't.total',
      't.paid_total',
      't.refunded_total',
      't.point_earned',
      't.point_used',
      't.is_new_customer',
      't.completed_at',
      't.voided_at',
      't.created_at',
      't.version',
    ])
    // millisecond precision so the cursor (JS Date) round-trips exactly
    .orderBy(sql`date_trunc('milliseconds', t.created_at)`, 'desc')
    .orderBy('t.id', 'desc')
    .limit(input.limit + 1);
  q = txFilters(ctx, input, tz)(q);
  const c = decodeCursor(input.cursor);
  if (c) q = q.where(sql<boolean>`(date_trunc('milliseconds', t.created_at), t.id) < (${new Date(String(c.v))}::timestamptz, ${c.id}::uuid)`);
  return paginate(await q.execute(), input.limit, (r) => r.created_at);
}

// =============================================================================================
// Draft: create & items
// =============================================================================================

async function assertStaffInOrg(ctx: Ctx, staffIds: string[]) {
  const ids = [...new Set(staffIds)];
  if (!ids.length) return;
  const rows = await ctx.trx.selectFrom('staffs').select('id').where('id', 'in', ids).where('deleted_at', 'is', null).execute();
  if (rows.length !== ids.length) throw Errors.validation('存在しない担当スタッフが含まれています');
}

export async function createTransaction(ctx: Ctx, input: CreateTransactionInput) {
  requirePermission(ctx.actor, 'pos.operate');
  assertShopAccess(ctx.actor, input.shopId);
  await loadPosShop(ctx, input.shopId);
  let customerId = input.customerId ?? null;
  let staffId = input.staffId ?? null;
  let isNominated = input.isNominated ?? false;
  const items: ItemInput[] = [];

  if (input.appointmentId) {
    const appt = await ctx.trx.selectFrom('appointments').selectAll().where('id', '=', input.appointmentId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!appt) throw Errors.notFound('予約', input.appointmentId);
    if (appt.shop_id !== input.shopId) throw Errors.validation('予約の店舗と会計の店舗が一致しません');
    if (['cancelled', 'no_show'].includes(appt.status)) throw Errors.business('APPOINTMENT_NOT_BILLABLE', 'キャンセル済みの予約は会計できません', { status: appt.status });
    const active = await ctx.trx
      .selectFrom('transactions')
      .select(['id', 'status'])
      .where('appointment_id', '=', appt.id)
      .where('status', 'in', ['draft', 'completed', 'partially_refunded'])
      .executeTakeFirst();
    if (active) throw Errors.conflict('TRANSACTION_EXISTS', 'この予約の会計は既に作成されています', { transactionId: active.id, status: active.status });
    if (input.customerId && appt.customer_id && input.customerId !== appt.customer_id) throw Errors.validation('予約の顧客と異なる顧客は指定できません');
    customerId = appt.customer_id ?? customerId;
    staffId = input.staffId ?? appt.staff_id;
    isNominated = input.isNominated ?? appt.is_nominated;

    const services = await ctx.trx
      .selectFrom('appointment_services as s')
      .leftJoin('menus as m', 'm.id', 's.menu_id')
      .select(['s.menu_id', 's.name', 's.price', 's.tax_rate_bp', 's.staff_id', 'm.price_tax_included'])
      .where('s.appointment_id', '=', appt.id)
      .orderBy('s.sort_order')
      .execute();
    for (const s of services) {
      const lineStaff = s.staff_id ?? appt.staff_id;
      items.push({
        type: 'service',
        menuId: s.menu_id ?? undefined,
        name: s.name,
        quantity: 1,
        unitPrice: s.price_tax_included === false ? toInclusive(s.price, s.tax_rate_bp) : s.price,
        taxRateBp: s.tax_rate_bp,
        staff: lineStaff ? [{ staffId: lineStaff, shareBp: 10000, role: 'main', isNominated: appt.is_nominated && lineStaff === appt.staff_id }] : undefined,
      });
    }
    if (appt.is_nominated && appt.staff_id) {
      const st = await ctx.trx.selectFrom('staffs').select(['nomination_fee']).where('id', '=', appt.staff_id).executeTakeFirst();
      if (st && st.nomination_fee > 0) {
        items.push({ type: 'nomination_fee', name: '指名料', quantity: 1, unitPrice: st.nomination_fee, taxRateBp: 1000, staff: [{ staffId: appt.staff_id, shareBp: 10000, role: 'main', isNominated: true }] });
      }
    }
    if (appt.coupon_id) items.push({ type: 'coupon', couponId: appt.coupon_id, quantity: 1 });
  } else if (customerId) {
    await assertCustomerAccess(ctx, customerId);
  }
  if (staffId) await assertStaffInOrg(ctx, [staffId]);

  const tx = await ctx.trx
    .insertInto('transactions')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId,
      appointment_id: input.appointmentId ?? null,
      customer_id: customerId,
      staff_id: staffId,
      is_nominated: isNominated,
      note: input.note ?? null,
      created_by: auditUserId(ctx.actor),
      updated_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  let warnings: string[] = [];
  if (items.length) warnings = await applyItems(ctx, tx, items, { lenientCoupons: true });
  await audit(ctx, { action: 'transaction.create', resourceType: 'transaction', resourceId: tx.id, shopId: tx.shop_id, after: { appointmentId: tx.appointment_id, customerId, staffId } });
  return { ...(await getTransactionUnchecked(ctx, tx.id)), warnings };
}

interface ResolvedPositive {
  idx: number;
  itemType: ItemType;
  menuId: string | null;
  productId: string | null;
  couponId: null;
  name: string;
  quantity: number;
  unitPrice: number;
  lineDiscount: number;
  lineDiscountPercent: number;
  taxRateBp: number;
  staff: StaffShare[];
  details: Record<string, unknown>;
}

interface ResolvedDiscount {
  idx: number;
  itemType: ItemType;
  couponId: string | null;
  name: string;
  kind: 'amount' | 'percent';
  value: number;
  eligible?: number[];
  details: Record<string, unknown>;
}

/**
 * Resolve inputs (menus/products/coupons), recalculate totals, and replace the draft's lines.
 * Returns non-fatal warnings (e.g. a prefilled appointment coupon that is no longer valid).
 */
async function applyItems(ctx: Ctx, tx: TxRow, inputs: ItemInput[], opts: { lenientCoupons?: boolean } = {}): Promise<string[]> {
  const shop = await loadPosShop(ctx, tx.shop_id);
  const warnings: string[] = [];
  const menuIds = [...new Set(inputs.filter((i) => i.type === 'service' && i.menuId).map((i) => i.menuId!))];
  const productIds = [...new Set(inputs.filter((i) => i.type === 'product').map((i) => i.productId!))];
  const menus = menuIds.length ? await effectiveMenus(ctx, tx.shop_id, { includeInactive: true, menuIds }) : [];
  const products = productIds.length
    ? await ctx.trx
        .selectFrom('products')
        .select(['id', 'name', 'price', 'price_tax_included', 'tax_rate_bp', 'status', 'shop_id'])
        .where('id', 'in', productIds)
        .where('deleted_at', 'is', null)
        .execute()
    : [];
  await assertStaffInOrg(ctx, inputs.flatMap((i) => (i.staff ?? []).map((s) => s.staffId)));
  const defaultStaff: StaffShare[] = tx.staff_id ? [{ staffId: tx.staff_id, shareBp: 10000, role: 'main', isNominated: tx.is_nominated }] : [];

  const positives: ResolvedPositive[] = [];
  const discounts: ResolvedDiscount[] = [];
  const couponInputs: { idx: number; input: ItemInput }[] = [];
  const nominationFees = new Map<string, number>();

  for (const [idx, it] of inputs.entries()) {
    const staff: StaffShare[] = it.staff?.length ? it.staff.map((s) => ({ staffId: s.staffId, shareBp: s.shareBp, role: s.role, isNominated: s.isNominated })) : defaultStaff;
    const base = { idx, itemType: it.type as ItemType, couponId: null, quantity: it.quantity, lineDiscount: it.lineDiscount ?? 0, lineDiscountPercent: it.lineDiscountPercent ?? 0, staff, details: {} as Record<string, unknown> };
    switch (it.type) {
      case 'service': {
        const m = it.menuId ? menus.find((x) => x.id === it.menuId) : undefined;
        if (it.menuId && !m) throw Errors.validation('存在しないメニューが含まれています', { menuId: it.menuId });
        const taxRateBp = it.taxRateBp ?? m?.taxRateBp ?? 1000;
        const unitPrice = it.unitPrice ?? (m!.priceTaxIncluded ? m!.price : toInclusive(m!.price, m!.taxRateBp));
        positives.push({ ...base, menuId: it.menuId ?? null, productId: null, name: it.name ?? m!.name, unitPrice, taxRateBp });
        break;
      }
      case 'product': {
        const p = products.find((x) => x.id === it.productId);
        if (!p || (p.shop_id && p.shop_id !== tx.shop_id)) throw Errors.validation('この店舗で販売できない商品が含まれています', { productId: it.productId });
        if (p.status !== 'active') throw Errors.business('PRODUCT_INACTIVE', `販売停止中の商品です: ${p.name}`);
        const taxRateBp = it.taxRateBp ?? p.tax_rate_bp;
        const unitPrice = it.unitPrice ?? (p.price_tax_included ? p.price : toInclusive(p.price, p.tax_rate_bp));
        positives.push({ ...base, menuId: null, productId: p.id, name: it.name ?? p.name, unitPrice, taxRateBp });
        break;
      }
      case 'nomination_fee': {
        let unitPrice = it.unitPrice;
        if (unitPrice === undefined) {
          const sid = staff[0]?.staffId;
          if (!sid) throw Errors.validation('指名料の担当スタッフを指定してください');
          if (!nominationFees.has(sid)) {
            const st = await ctx.trx.selectFrom('staffs').select('nomination_fee').where('id', '=', sid).executeTakeFirstOrThrow();
            nominationFees.set(sid, st.nomination_fee);
          }
          unitPrice = nominationFees.get(sid)!;
        }
        positives.push({ ...base, menuId: null, productId: null, name: it.name ?? '指名料', unitPrice, taxRateBp: it.taxRateBp ?? 1000 });
        break;
      }
      case 'adjustment': {
        if (it.unitPrice! > 0) positives.push({ ...base, menuId: null, productId: null, name: it.name ?? '調整', unitPrice: it.unitPrice!, taxRateBp: it.taxRateBp ?? 1000, details: { adjustment: true } });
        else discounts.push({ idx, itemType: 'adjustment', couponId: null, name: it.name ?? '調整', kind: 'amount', value: -it.unitPrice! * it.quantity, details: { adjustment: true } });
        break;
      }
      case 'discount': {
        const kind = it.percent !== undefined ? 'percent' : 'amount';
        const value = (kind === 'percent' ? it.percent : it.amount)!;
        discounts.push({ idx, itemType: 'discount', couponId: null, name: it.name ?? (kind === 'percent' ? `値引 ${value}%` : '値引'), kind, value, details: kind === 'percent' ? { percent: value } : { amount: value } });
        break;
      }
      case 'coupon':
        couponInputs.push({ idx, input: it });
        break;
    }
  }

  // coupons are evaluated on line amounts after line-level discounts
  if (couponInputs.length) {
    const pre = calculate(positives, [], shop.settings.pos.roundingMode);
    const seen = new Set<string>();
    for (const { idx, input } of couponInputs) {
      const couponId = input.couponId!;
      if (seen.has(couponId)) throw Errors.validation('同じクーポンは1回のみ利用できます');
      seen.add(couponId);
      const ev = await evaluateCoupon(ctx, {
        couponId,
        shopId: tx.shop_id,
        customerId: tx.customer_id,
        lines: positives.map((p, i) => ({ menuId: p.menuId, amount: pre.lines[i]!.amount })),
        excludeAppointmentId: tx.appointment_id ?? undefined,
        excludeTransactionId: tx.id,
      }).catch((err) => {
        if (opts.lenientCoupons && (err as { category?: string }).category === 'not_found') return { couponId, name: 'クーポン', valid: false, reason: '削除されたクーポンです', discountAmount: 0 };
        throw err;
      });
      if (!ev.valid) {
        if (opts.lenientCoupons) {
          warnings.push(`クーポン「${ev.name}」は適用できません: ${ev.reason ?? ''}`);
          continue;
        }
        throw Errors.business('COUPON_INVALID', ev.reason ?? 'クーポンを利用できません', { couponId });
      }
      const c = await ctx.trx.selectFrom('coupons').select(['applicable_menu_ids']).where('id', '=', couponId).executeTakeFirstOrThrow();
      const eligible = c.applicable_menu_ids.length ? positives.filter((p) => p.menuId && c.applicable_menu_ids.includes(p.menuId)).map((p) => p.idx) : undefined;
      discounts.push({ idx, itemType: 'coupon', couponId, name: input.name ?? ev.name, kind: 'amount', value: ev.discountAmount, eligible, details: {} });
    }
  }
  discounts.sort((a, b) => a.idx - b.idx);

  const calcLines: CalcLine[] = positives.map((p) => ({ idx: p.idx, quantity: p.quantity, unitPrice: p.unitPrice, lineDiscount: p.lineDiscount, lineDiscountPercent: p.lineDiscountPercent, taxRateBp: p.taxRateBp }));
  const calcDiscounts: CalcDiscount[] = discounts.map((d) => ({ idx: d.idx, kind: d.kind, value: d.value, eligible: d.eligible }));
  const result = calculate(calcLines, calcDiscounts, shop.settings.pos.roundingMode);

  // payments already taken must still fit into the new total
  const bal = await outstandingBalance(ctx, { transactionId: tx.id });
  if (bal.held > result.total) {
    throw Errors.business('PAYMENTS_EXCEED_TOTAL', '受領済みの支払いが合計金額を超えます。先に支払いを取り消してください', { total: result.total, paid: bal.held });
  }

  await ctx.trx.deleteFrom('transaction_items').where('transaction_id', '=', tx.id).execute();
  const lineResults = new Map(result.lines.map((l) => [l.idx, l]));
  const discountResults = new Map(result.discounts.map((d) => [d.idx, d]));
  const rows: { idx: number; values: any; staff: StaffShare[]; net: number }[] = [];
  for (const p of positives) {
    const r = lineResults.get(p.idx)!;
    rows.push({
      idx: p.idx,
      staff: p.staff,
      net: r.net,
      values: {
        item_type: p.itemType,
        menu_id: p.menuId,
        product_id: p.productId,
        coupon_id: null,
        name: p.name,
        quantity: p.quantity,
        unit_price: p.unitPrice,
        line_discount: r.lineDiscount,
        tax_rate_bp: p.taxRateBp,
        amount: r.amount,
        allocated_discount: r.allocatedDiscount,
        net_amount: r.net,
        tax_amount: r.taxAmount,
        details: JSON.stringify({ ...p.details, ...(p.lineDiscountPercent ? { lineDiscountPercent: p.lineDiscountPercent } : {}) }),
      },
    });
  }
  for (const d of discounts) {
    const amt = discountResults.get(d.idx)!.amount;
    rows.push({
      idx: d.idx,
      staff: [],
      net: 0,
      values: {
        item_type: d.itemType,
        menu_id: null,
        product_id: null,
        coupon_id: d.couponId,
        name: d.name,
        quantity: 1,
        unit_price: -amt,
        line_discount: 0,
        tax_rate_bp: 0,
        amount: -amt,
        allocated_discount: 0,
        net_amount: 0,
        tax_amount: 0,
        details: JSON.stringify({ ...d.details, ...(d.eligible ? { eligibleLines: d.eligible } : {}) }),
      },
    });
  }
  rows.sort((a, b) => a.idx - b.idx);
  if (rows.length) {
    const inserted = await ctx.trx
      .insertInto('transaction_items')
      .values(rows.map((r) => ({ ...r.values, organization_id: ctx.actor.organizationId, transaction_id: tx.id, sort_order: r.idx })))
      .returning(['id', 'sort_order'])
      .execute();
    const staffRows = inserted.flatMap((ins) => {
      const r = rows.find((x) => x.idx === ins.sort_order)!;
      return allocateStaff(r.net, r.staff).map((s) => ({
        organization_id: ctx.actor.organizationId,
        transaction_item_id: ins.id,
        staff_id: s.staffId,
        role: s.role,
        share_bp: s.shareBp,
        is_nominated: s.isNominated,
        allocated_amount: s.allocatedAmount,
      }));
    });
    if (staffRows.length) await ctx.trx.insertInto('transaction_item_staff').values(staffRows).execute();
  }
  await ctx.trx
    .updateTable('transactions')
    .set({
      subtotal: result.subtotal,
      discount_total: result.discountTotal,
      tax_total: result.taxTotal,
      total: result.total,
      tax_breakdown: JSON.stringify(result.taxBreakdown),
      version: tx.version + 1,
      updated_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .where('id', '=', tx.id)
    .execute();
  return warnings;
}

export async function replaceItems(ctx: Ctx, id: string, input: ReplaceItemsInput) {
  requirePermission(ctx.actor, 'pos.operate');
  let tx = await lockTx(ctx, id);
  requireDraft(tx);
  if (tx.version !== input.version) {
    throw Errors.conflict('VERSION_CONFLICT', '他の操作で会計が更新されています。最新の内容を確認してください', { currentVersion: tx.version });
  }
  const patch: Record<string, unknown> = {};
  if (input.customerId !== undefined && input.customerId !== tx.customer_id) {
    if (tx.appointment_id) throw Errors.validation('予約に紐づく会計の顧客は変更できません');
    if (tx.point_used > 0) throw Errors.business('POINTS_IN_USE', 'ポイント利用中は顧客を変更できません');
    if (input.customerId) await assertCustomerAccess(ctx, input.customerId);
    patch.customer_id = input.customerId;
  }
  if (input.staffId !== undefined && input.staffId !== tx.staff_id) {
    if (input.staffId) await assertStaffInOrg(ctx, [input.staffId]);
    patch.staff_id = input.staffId;
  }
  if (input.isNominated !== undefined) patch.is_nominated = input.isNominated;
  if (input.note !== undefined) patch.note = input.note;
  if (Object.keys(patch).length) {
    tx = await ctx.trx.updateTable('transactions').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  }
  const before = { total: tx.total, items: (await ctx.trx.selectFrom('transaction_items').select(['name', 'amount']).where('transaction_id', '=', id).execute()).length };
  const warnings = await applyItems(ctx, tx, input.items);
  const after = await getTransactionUnchecked(ctx, id);
  await audit(ctx, { action: 'transaction.update_items', resourceType: 'transaction', resourceId: id, shopId: tx.shop_id, before, after: { total: after.total, items: after.items.length } });
  return { ...after, warnings };
}

// =============================================================================================
// Payments on a draft
// =============================================================================================

/** paid_total / change_total / point_used derived from captured payments */
export async function recomputePaid(ctx: Ctx, txId: string) {
  const agg = await ctx.trx
    .selectFrom('payments')
    .select([
      sql<number>`coalesce(sum(amount - refunded_amount), 0)::int`.as('paid'),
      sql<number>`coalesce(sum(change_amount), 0)::int`.as('change'),
      sql<number>`coalesce(sum(amount) FILTER (WHERE method = 'point'), 0)::int`.as('points'),
    ])
    .where('transaction_id', '=', txId)
    .where('status', 'in', [...CAPTURED])
    .executeTakeFirstOrThrow();
  await ctx.trx.updateTable('transactions').set({ paid_total: agg.paid, change_total: agg.change, point_used: agg.points }).where('id', '=', txId).execute();
  return agg;
}

export async function addPayment(ctx: Ctx, id: string, input: AddPaymentInput, headerKey?: string) {
  requirePermission(ctx.actor, 'pos.operate');
  const key = requireKey(input.idempotencyKey, headerKey);
  const tx = await lockTx(ctx, id);
  const replay = await ctx.trx.selectFrom('payments').select(['id', 'transaction_id']).where('idempotency_key', '=', key).executeTakeFirst();
  if (replay) {
    if (replay.transaction_id !== id) throw Errors.business('IDEMPOTENCY_KEY_REUSED', '同じIdempotency-Keyが異なる決済で使用されています');
    return { paymentId: replay.id, replayed: true, transaction: await getTransactionUnchecked(ctx, id) };
  }
  requireDraft(tx);
  const bal = await outstandingBalance(ctx, { transactionId: id });
  if (bal.outstanding <= 0) throw Errors.business('NOTHING_TO_PAY', '未払い残高がありません');

  let paymentId: string;
  if (input.method === 'card' && input.online) {
    const res = await startOnlinePayment(ctx, { transactionId: id, amount: input.amount ?? bal.outstanding, idempotencyKey: key, customerId: tx.customer_id, description: '店頭会計' });
    paymentId = res.paymentId;
  } else {
    if (input.online) throw Errors.validation('オンライン決済はカードのみ指定できます');
    if (input.method !== 'cash' && input.tenderedAmount !== undefined) throw Errors.validation('お預かり金額は現金のみ指定できます');
    let amount = input.amount;
    if (input.method === 'cash') amount ??= Math.min(bal.outstanding, input.tenderedAmount ?? bal.outstanding);
    if (input.method === 'point') {
      if (!tx.customer_id) throw Errors.business('CUSTOMER_REQUIRED', 'ポイント利用には顧客の指定が必要です');
      const c = await ctx.trx.selectFrom('customers').select('point_balance').where('id', '=', tx.customer_id).executeTakeFirstOrThrow();
      const available = c.point_balance - tx.point_used;
      amount ??= Math.min(bal.outstanding, available);
      if (amount > available) throw Errors.business('INSUFFICIENT_POINTS', 'ポイント残高が不足しています', { balance: c.point_balance, used: tx.point_used });
    }
    if (input.method === 'custom') {
      if (!input.customMethodId) throw Errors.validation('店舗独自決済の種類を指定してください');
      const m = await ctx.trx.selectFrom('custom_payment_methods').select(['id', 'shop_id', 'is_active']).where('id', '=', input.customMethodId).executeTakeFirst();
      if (!m || !m.is_active || (m.shop_id && m.shop_id !== tx.shop_id)) throw Errors.validation('利用できない店舗独自決済です');
    }
    amount ??= bal.outstanding;
    if (!amount || amount <= 0) throw Errors.validation('金額が不正です');
    const res = await recordOfflinePayment(ctx, {
      transactionId: id,
      method: input.method,
      amount,
      tenderedAmount: input.method === 'cash' ? (input.tenderedAmount ?? amount) : undefined,
      customMethodId: input.customMethodId,
      idempotencyKey: key,
      metadata: input.note ? { note: input.note } : {},
    });
    paymentId = res.payment.id;
  }
  await recomputePaid(ctx, id);
  const p = await ctx.trx.selectFrom('payments').select(['method', 'amount', 'change_amount', 'status']).where('id', '=', paymentId).executeTakeFirstOrThrow();
  await audit(ctx, { action: 'transaction.payment_add', resourceType: 'transaction', resourceId: id, shopId: tx.shop_id, after: { paymentId, method: p.method, amount: p.amount, status: p.status } });
  return { paymentId, replayed: false, change: p.change_amount, transaction: await getTransactionUnchecked(ctx, id) };
}

export async function removePayment(ctx: Ctx, id: string, paymentId: string) {
  requirePermission(ctx.actor, 'pos.operate');
  const tx = await lockTx(ctx, id);
  requireDraft(tx);
  const p = await ctx.trx.selectFrom('payments').select(['id', 'transaction_id', 'method', 'amount']).where('id', '=', paymentId).executeTakeFirst();
  if (!p || p.transaction_id !== id) throw Errors.notFound('決済', paymentId);
  await cancelPayment(ctx, paymentId, { reason: '会計編集で取消' });
  await recomputePaid(ctx, id);
  await audit(ctx, { action: 'transaction.payment_remove', resourceType: 'transaction', resourceId: id, shopId: tx.shop_id, before: { paymentId, method: p.method, amount: p.amount } });
  return getTransactionUnchecked(ctx, id);
}

/** Set the number of points used on a draft (replaces any previous point payment) */
export async function setPointUse(ctx: Ctx, id: string, use: number) {
  requirePermission(ctx.actor, 'pos.operate');
  const tx = await lockTx(ctx, id);
  requireDraft(tx);
  if (use === tx.point_used) return getTransactionUnchecked(ctx, id);
  if (use > 0 && !tx.customer_id) throw Errors.business('CUSTOMER_REQUIRED', 'ポイント利用には顧客の指定が必要です');
  const current = await ctx.trx.selectFrom('payments').select(['id']).where('transaction_id', '=', id).where('method', '=', 'point').where('status', '=', 'succeeded').execute();
  for (const p of current) await cancelPayment(ctx, p.id, { reason: 'ポイント利用変更' });
  if (use > 0) {
    const c = await ctx.trx.selectFrom('customers').select('point_balance').where('id', '=', tx.customer_id!).executeTakeFirstOrThrow();
    if (use > c.point_balance) throw Errors.business('INSUFFICIENT_POINTS', 'ポイント残高が不足しています', { balance: c.point_balance });
    const bal = await outstandingBalance(ctx, { transactionId: id });
    if (use > bal.outstanding) throw Errors.business('POINTS_EXCEED_TOTAL', '利用ポイントが未払い残高を超えています', { outstanding: bal.outstanding });
    await recordOfflinePayment(ctx, { transactionId: id, method: 'point', amount: use, idempotencyKey: `points:${id}:${randomUUID()}` });
  }
  await recomputePaid(ctx, id);
  await audit(ctx, { action: 'transaction.points_use', resourceType: 'transaction', resourceId: id, shopId: tx.shop_id, before: { pointUsed: tx.point_used }, after: { pointUsed: use } });
  return getTransactionUnchecked(ctx, id);
}

// =============================================================================================
// Complete
// =============================================================================================

export async function completeTransaction(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'pos.operate');
  const tx = await lockTx(ctx, id);
  if ((SOLD_STATUSES as readonly string[]).includes(tx.status)) return { ...(await getTransactionUnchecked(ctx, id)), warnings: [], replayed: true };
  requireDraft(tx);
  const shop = await loadPosShop(ctx, tx.shop_id);
  const items = await ctx.trx.selectFrom('transaction_items').selectAll().where('transaction_id', '=', id).orderBy('sort_order').execute();
  if (!items.length) throw Errors.business('EMPTY_TRANSACTION', '明細がありません');

  const payments = await ctx.trx.selectFrom('payments').selectAll().where('transaction_id', '=', id).execute();
  if (payments.some((p) => ['pending', 'requires_action'].includes(p.status))) throw Errors.business('PAYMENT_PENDING', '処理中のオンライン決済があります');
  const captured = payments.filter((p) => (CAPTURED as readonly string[]).includes(p.status));
  const paid = captured.reduce((s, p) => s + p.amount - p.refunded_amount, 0);
  if (paid !== tx.total) throw Errors.business('PAYMENT_INCOMPLETE', paid < tx.total ? 'お支払いが不足しています' : 'お支払いが合計金額を超えています', { total: tx.total, paid });

  const session = await findOpenSession(ctx, tx.shop_id);
  if (shop.settings.pos.requireOpenRegister && !session) throw Errors.business('REGISTER_NOT_OPEN', 'レジが開局されていません');

  const now = new Date();
  const year = localYear(now, shop.timezone);
  const number = formatNumber('', year, await nextCounter(ctx, `tx:${tx.shop_id}:${year}`));
  const warnings: string[] = [];
  const stockWarnings: { productId: string; name: string; quantity: number }[] = [];

  // stock (allow negative, but report)
  const productLines = items.filter((i) => i.item_type === 'product' && i.product_id);
  if (productLines.length) {
    const managed = new Set(
      (await ctx.trx.selectFrom('products').select('id').where('id', 'in', productLines.map((i) => i.product_id!)).where('stock_managed', '=', true).execute()).map((r) => r.id),
    );
    for (const line of productLines) {
      if (!managed.has(line.product_id!)) continue;
      const qty = await adjustStock(ctx, { productId: line.product_id!, shopId: tx.shop_id, delta: -line.quantity, reason: 'sale', transactionId: id });
      if (qty < 0) {
        stockWarnings.push({ productId: line.product_id!, name: line.name, quantity: qty });
        warnings.push(`在庫がマイナスになりました: ${line.name} (${qty})`);
      }
    }
  }

  // coupons → redeemed; appointment reservations for coupons not used are released
  const couponIds = items.filter((i) => i.item_type === 'coupon' && i.coupon_id).map((i) => i.coupon_id!);
  for (const couponId of couponIds) {
    const reserved = tx.appointment_id
      ? await ctx.trx.selectFrom('coupon_redemptions').select('id').where('appointment_id', '=', tx.appointment_id).where('coupon_id', '=', couponId).where('status', '=', 'reserved').executeTakeFirst()
      : undefined;
    if (reserved) {
      await ctx.trx.updateTable('coupon_redemptions').set({ status: 'redeemed', transaction_id: id, customer_id: tx.customer_id }).where('id', '=', reserved.id).execute();
    } else {
      await ctx.trx
        .insertInto('coupon_redemptions')
        .values({ organization_id: ctx.actor.organizationId, coupon_id: couponId, customer_id: tx.customer_id, appointment_id: tx.appointment_id, transaction_id: id, status: 'redeemed' })
        .execute();
    }
  }
  if (tx.appointment_id) {
    let rel = ctx.trx.updateTable('coupon_redemptions').set({ status: 'released' }).where('appointment_id', '=', tx.appointment_id).where('status', '=', 'reserved');
    if (couponIds.length) rel = rel.where('coupon_id', 'not in', couponIds);
    await rel.execute();
  }

  // points: redeem (already taken as a 'point' payment) + earn on the amount paid by other means
  const pointUsed = captured.filter((p) => p.method === 'point').reduce((s, p) => s + p.amount, 0);
  let pointEarned = 0;
  let isNew: boolean | null = null;
  if (tx.customer_id) {
    if (pointUsed > 0) await applyPoints(ctx, { customerId: tx.customer_id, delta: -pointUsed, reason: 'redeem', transactionId: id, note: `会計 ${number}` });
    pointEarned = pointsFor(tx.total - pointUsed, shop.settings.pos.pointRateBp);
    if (pointEarned > 0) {
      const days = shop.settings.pos.pointExpiryDays;
      await applyPoints(ctx, { customerId: tx.customer_id, delta: pointEarned, reason: 'earn', transactionId: id, note: `会計 ${number}`, expiresAt: days > 0 ? addDays(now, days) : null });
    }
    const prior = await ctx.trx
      .selectFrom('transactions')
      .select('id')
      .where('customer_id', '=', tx.customer_id)
      .where('status', 'in', [...SOLD_STATUSES])
      .where('id', '!=', id)
      .limit(1)
      .executeTakeFirst();
    isNew = !prior;
  } else if (pointUsed > 0) throw Errors.business('CUSTOMER_REQUIRED', 'ポイント利用には顧客の指定が必要です');

  await ctx.trx
    .updateTable('transactions')
    .set({
      status: 'completed',
      transaction_number: number,
      completed_at: now,
      completed_by: ctx.actor.kind === 'staff' ? ctx.actor.staffId : null,
      register_session_id: session?.id ?? null,
      paid_total: paid,
      change_total: captured.reduce((s, p) => s + p.change_amount, 0),
      point_used: pointUsed,
      point_earned: pointEarned,
      is_new_customer: isNew,
      version: tx.version + 1,
      updated_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .where('id', '=', id)
    .execute();

  // appointment → completed (trusted: POS is the system of record for the visit)
  if (tx.appointment_id) {
    const appt = await ctx.trx.selectFrom('appointments').select(['status']).where('id', '=', tx.appointment_id).executeTakeFirstOrThrow();
    if (appt.status !== 'completed') {
      if (appt.status === 'tentative') await transitionAppointment(ctx, tx.appointment_id, 'confirmed', { trusted: true });
      await transitionAppointment(ctx, tx.appointment_id, 'completed', { trusted: true });
      await ctx.trx.updateTable('transactions').set({ appointment_completed_by_tx: true }).where('id', '=', id).execute();
    }
  }
  if (tx.customer_id) {
    await ensureVisitedRelation(ctx, tx.customer_id, tx.shop_id);
    await recomputeCustomerStats(ctx, tx.customer_id);
  }
  await audit(ctx, {
    action: 'transaction.complete',
    resourceType: 'transaction',
    resourceId: id,
    shopId: tx.shop_id,
    after: { transactionNumber: number, total: tx.total, paid, pointUsed, pointEarned, registerSessionId: session?.id ?? null },
    metadata: stockWarnings.length ? { negativeStock: stockWarnings } : undefined,
  });
  await emit(ctx, {
    type: 'transaction.completed',
    aggregateType: 'transaction',
    aggregateId: id,
    payload: { transactionId: id, shopId: tx.shop_id, customerId: tx.customer_id, appointmentId: tx.appointment_id, total: tx.total, completedAt: now.toISOString(), staffId: tx.staff_id, transactionNumber: number },
  });
  return { ...(await getTransactionUnchecked(ctx, id)), warnings, stockWarnings, replayed: false };
}

// =============================================================================================
// Void
// =============================================================================================

export async function voidTransaction(ctx: Ctx, id: string, reason: string) {
  const tx = await lockTx(ctx, id);
  if (tx.status === 'voided') return getTransactionUnchecked(ctx, id);
  const payments = await ctx.trx.selectFrom('payments').selectAll().where('transaction_id', '=', id).execute();
  const now = new Date();
  const staffId = ctx.actor.kind === 'staff' ? ctx.actor.staffId : null;

  if (tx.status === 'draft') {
    // discarding a draft: release whatever was taken
    requirePermission(ctx.actor, 'pos.operate');
    await ctx.trx.updateTable('transactions').set({ status: 'voided', voided_at: now, voided_by: staffId, void_reason: reason, version: tx.version + 1 }).where('id', '=', id).execute();
    for (const p of payments) {
      if (p.status === 'cancelled' || p.status === 'failed') continue;
      if (p.method === 'online' && (CAPTURED as readonly string[]).includes(p.status)) {
        if (p.amount > p.refunded_amount) await refundPayment(ctx, { paymentId: p.id, amount: p.amount - p.refunded_amount, reason: `会計破棄: ${reason}`, idempotencyKey: `void:${id}:${p.id}` });
      } else await cancelPayment(ctx, p.id, { reason: '会計破棄', allowSucceededOffline: true });
    }
    await audit(ctx, { action: 'transaction.discard', resourceType: 'transaction', resourceId: id, shopId: tx.shop_id, after: { reason } });
    return getTransactionUnchecked(ctx, id);
  }

  requirePermission(ctx.actor, 'pos.void');
  if (tx.status !== 'completed') throw Errors.business('VOID_NOT_ALLOWED', '返金済みの会計は取消できません。返金をご利用ください', { status: tx.status });
  const shop = await loadPosShop(ctx, tx.shop_id);
  const sameDay = !!tx.completed_at && localDate(tx.completed_at, shop.timezone) === localDate(now, shop.timezone);
  let originalSessionOpen = false;
  if (tx.register_session_id) {
    const s = await ctx.trx.selectFrom('register_sessions').select('status').where('id', '=', tx.register_session_id).executeTakeFirst();
    originalSessionOpen = s?.status === 'open';
  }
  if (!sameDay && !originalSessionOpen) {
    throw Errors.business('VOID_NOT_ALLOWED', '取消は会計当日またはレジ締め前のみ可能です。返金をご利用ください');
  }

  // mark voided first: payment.refunded subscribers must not treat the reversal as a partial refund
  await ctx.trx
    .updateTable('transactions')
    .set({ status: 'voided', voided_at: now, voided_by: staffId, void_reason: reason, version: tx.version + 1, updated_by: auditUserId(ctx.actor) })
    .where('id', '=', id)
    .execute();

  let cashOut = 0;
  for (const p of payments) {
    if (!(CAPTURED as readonly string[]).includes(p.status)) continue;
    if (p.method === 'online') {
      if (p.amount > p.refunded_amount) await refundPayment(ctx, { paymentId: p.id, amount: p.amount - p.refunded_amount, reason: `会計取消: ${reason}`, idempotencyKey: `void:${id}:${p.id}` });
    } else {
      await cancelPayment(ctx, p.id, { reason: '会計取消', allowSucceededOffline: true });
      if (p.method === 'cash') cashOut += p.amount;
    }
  }
  const warnings: string[] = [];
  // cash already counted in a closed session leaves the drawer of the current session
  if (cashOut > 0 && !originalSessionOpen && tx.register_session_id) {
    const current = await findOpenSession(ctx, tx.shop_id);
    if (current) {
      await ctx.trx
        .insertInto('register_cash_movements')
        .values({ organization_id: ctx.actor.organizationId, register_session_id: current.id, movement_type: 'pay_out', amount: cashOut, reason: `会計取消 ${tx.transaction_number}`, staff_id: staffId })
        .execute();
    } else warnings.push('レジが開局されていないため現金返金を出金記録できませんでした');
  }

  // stock back
  const items = await ctx.trx.selectFrom('transaction_items').selectAll().where('transaction_id', '=', id).execute();
  const productLines = items.filter((i) => i.item_type === 'product' && i.product_id && i.quantity > i.returned_quantity);
  if (productLines.length) {
    const managed = new Set(
      (await ctx.trx.selectFrom('products').select('id').where('id', 'in', productLines.map((i) => i.product_id!)).where('stock_managed', '=', true).execute()).map((r) => r.id),
    );
    for (const line of productLines) {
      if (managed.has(line.product_id!)) await adjustStock(ctx, { productId: line.product_id!, shopId: tx.shop_id, delta: line.quantity - line.returned_quantity, reason: 'cancel', transactionId: id, note: '会計取消' });
    }
  }

  // points: give back redeemed, take back earned (never below zero)
  if (tx.customer_id) {
    if (tx.point_used > 0) await applyPoints(ctx, { customerId: tx.customer_id, delta: tx.point_used, reason: 'revert', transactionId: id, note: 'void:redeem' });
    if (tx.point_earned > 0) await applyPoints(ctx, { customerId: tx.customer_id, delta: -tx.point_earned, reason: 'revert', transactionId: id, note: 'void:earn', clampAtZero: true });
  }
  await ctx.trx.updateTable('coupon_redemptions').set({ status: 'released' }).where('transaction_id', '=', id).where('status', '=', 'redeemed').execute();

  if (tx.appointment_id && tx.appointment_completed_by_tx) {
    const appt = await ctx.trx.selectFrom('appointments').select('status').where('id', '=', tx.appointment_id).executeTakeFirst();
    if (appt?.status === 'completed') await transitionAppointment(ctx, tx.appointment_id, 'in_service', { trusted: true, reason: '会計取消' });
  }
  if (tx.customer_id) await recomputeCustomerStats(ctx, tx.customer_id);
  await audit(ctx, { action: 'transaction.void', resourceType: 'transaction', resourceId: id, shopId: tx.shop_id, before: { status: tx.status }, after: { status: 'voided', reason } });
  await emit(ctx, {
    type: 'transaction.voided',
    aggregateType: 'transaction',
    aggregateId: id,
    payload: { transactionId: id, shopId: tx.shop_id, customerId: tx.customer_id, appointmentId: tx.appointment_id, total: tx.total, completedAt: tx.completed_at?.toISOString() ?? null, reason },
  });
  return { ...(await getTransactionUnchecked(ctx, id)), warnings };
}

// =============================================================================================
// Refund (返品・返金)
// =============================================================================================

/** transactions whose refunds are being orchestrated by refundTransaction (subscriber skips them) */
const refundInProgress = new WeakSet<object>();

export function isRefundInProgress(ctx: Ctx) {
  return refundInProgress.has(ctx.trx);
}

const REFUND_ORDER: Record<string, number> = { online: 0, card: 1, emoney: 2, qr: 3, custom: 4, cash: 5, point: 6 };

/**
 * Derive refunded_total / status / point reversals from the refunds table. Idempotent: safe to call
 * any number of times (POS refunds, refunds made via /payments/:id/refund or provider webhooks).
 */
export async function syncRefundState(ctx: Ctx, txId: string, opts: { emitEvent?: boolean; reason?: string } = {}) {
  const tx = await ctx.trx.selectFrom('transactions').selectAll().where('id', '=', txId).forUpdate().executeTakeFirst();
  if (!tx || !(SOLD_STATUSES as readonly string[]).includes(tx.status)) return { changed: false };
  const rows = await ctx.trx
    .selectFrom('refunds as r')
    .innerJoin('payments as p', 'p.id', 'r.payment_id')
    .select(['p.method', sql<number>`sum(r.amount)::int`.as('amount')])
    .where('p.transaction_id', '=', txId)
    .where('r.status', '!=', 'failed')
    .groupBy('p.method')
    .execute();
  const refundedTotal = Math.min(tx.total, rows.reduce((s, r) => s + r.amount, 0));
  const pointRefunds = rows.find((r) => r.method === 'point')?.amount ?? 0;
  const status = refundedTotal <= 0 ? 'completed' : refundedTotal >= tx.total ? 'refunded' : 'partially_refunded';

  if (tx.customer_id) {
    // earned points are reverted in proportion to the refunded share
    const earnTarget = tx.total > 0 ? (refundedTotal >= tx.total ? tx.point_earned : Math.floor((tx.point_earned * refundedTotal) / tx.total)) : 0;
    const earnDone = -(await ledgerSum(ctx, txId, 'revert', 'refund:earn'));
    if (earnTarget > earnDone) await applyPoints(ctx, { customerId: tx.customer_id, delta: -(earnTarget - earnDone), reason: 'revert', transactionId: txId, note: 'refund:earn', clampAtZero: true });
    // refunded point payments go back to the customer
    const redeemDone = await ledgerSum(ctx, txId, 'revert', 'refund:redeem');
    if (pointRefunds > redeemDone) await applyPoints(ctx, { customerId: tx.customer_id, delta: pointRefunds - redeemDone, reason: 'revert', transactionId: txId, note: 'refund:redeem' });
  }
  const changed = refundedTotal !== tx.refunded_total || status !== tx.status;
  if (changed) {
    await ctx.trx.updateTable('transactions').set({ refunded_total: refundedTotal, status, version: tx.version + 1 }).where('id', '=', txId).execute();
    if (tx.customer_id) await recomputeCustomerStats(ctx, tx.customer_id);
    if (opts.emitEvent) {
      await emit(ctx, {
        type: 'transaction.refunded',
        aggregateType: 'transaction',
        aggregateId: txId,
        payload: {
          transactionId: txId,
          shopId: tx.shop_id,
          customerId: tx.customer_id,
          appointmentId: tx.appointment_id,
          total: tx.total,
          completedAt: tx.completed_at?.toISOString() ?? null,
          refundedAmount: refundedTotal - tx.refunded_total,
          refundedTotal,
          status,
        },
      });
    }
  }
  return { changed, refundedTotal, status };
}

export async function refundTransaction(ctx: Ctx, id: string, input: RefundTransactionInput, headerKey?: string) {
  requirePermission(ctx.actor, 'pos.refund');
  const key = requireKey(input.idempotencyKey, headerKey);
  const tx = await lockTx(ctx, id);
  const replay = await ctx.trx
    .selectFrom('refunds as r')
    .innerJoin('payments as p', 'p.id', 'r.payment_id')
    .select('r.id')
    .where('p.transaction_id', '=', id)
    .where('r.idempotency_key', 'like', `${key.replace(/[\\%_]/g, (m) => `\\${m}`)}:%`)
    .executeTakeFirst();
  if (replay) return { ...(await getTransactionUnchecked(ctx, id)), replayed: true };
  if (!['completed', 'partially_refunded'].includes(tx.status)) throw Errors.business('NOT_REFUNDABLE', 'この会計は返金できません', { status: tx.status });
  const remaining = tx.total - tx.refunded_total;
  if (input.amount > remaining) throw Errors.business('REFUND_EXCEEDS_TOTAL', '返金額が返金可能額を超えています', { refundable: remaining });

  const payments = (await ctx.trx.selectFrom('payments').selectAll().where('transaction_id', '=', id).execute())
    .filter((p) => (CAPTURED as readonly string[]).includes(p.status) && p.amount > p.refunded_amount)
    .filter((p) => !input.paymentId || p.id === input.paymentId)
    .sort((a, b) => (REFUND_ORDER[a.method] ?? 9) - (REFUND_ORDER[b.method] ?? 9) || a.created_at.getTime() - b.created_at.getTime());
  if (input.paymentId && !payments.length) throw Errors.business('PAYMENT_NOT_REFUNDABLE', '指定の決済は返金できません');
  const parts: { payment: (typeof payments)[number]; amount: number }[] = [];
  let left = input.amount;
  for (const p of payments) {
    if (left <= 0) break;
    const a = Math.min(left, p.amount - p.refunded_amount);
    parts.push({ payment: p, amount: a });
    left -= a;
  }
  if (left > 0) throw Errors.business('REFUND_EXCEEDS_PAYMENTS', '返金額が返金可能な決済額を超えています');

  const shop = await loadPosShop(ctx, tx.shop_id);
  const needsCash = parts.some((x) => x.payment.method === 'cash');
  const session = needsCash ? await findOpenSession(ctx, tx.shop_id) : null;
  if (needsCash && !session && shop.settings.pos.requireOpenRegister) throw Errors.business('REGISTER_NOT_OPEN', '現金返金にはレジの開局が必要です');

  // restock returned products
  const items = await ctx.trx.selectFrom('transaction_items').selectAll().where('transaction_id', '=', id).execute();
  for (const r of input.restockItems ?? []) {
    const line = items.find((i) => i.id === r.itemId);
    if (!line || line.item_type !== 'product' || !line.product_id) throw Errors.validation('返品できる商品明細ではありません', { itemId: r.itemId });
    if (line.returned_quantity + r.quantity > line.quantity) throw Errors.business('RETURN_EXCEEDS_QUANTITY', `返品数量が販売数量を超えています: ${line.name}`);
    await ctx.trx.updateTable('transaction_items').set({ returned_quantity: line.returned_quantity + r.quantity }).where('id', '=', line.id).execute();
    line.returned_quantity += r.quantity;
    const product = await ctx.trx.selectFrom('products').select('stock_managed').where('id', '=', line.product_id).executeTakeFirst();
    if (product?.stock_managed) await adjustStock(ctx, { productId: line.product_id, shopId: tx.shop_id, delta: r.quantity, reason: 'return', transactionId: id, note: input.reason });
  }

  refundInProgress.add(ctx.trx);
  try {
    for (const part of parts) {
      await refundPayment(ctx, {
        paymentId: part.payment.id,
        amount: part.amount,
        reason: input.reason,
        idempotencyKey: `${key}:${part.payment.id}`,
        registerSessionId: part.payment.method === 'cash' ? (session?.id ?? null) : null,
      });
    }
  } finally {
    refundInProgress.delete(ctx.trx);
  }
  await syncRefundState(ctx, id, { emitEvent: true, reason: input.reason });
  await audit(ctx, {
    action: 'transaction.refund',
    resourceType: 'transaction',
    resourceId: id,
    shopId: tx.shop_id,
    after: { amount: input.amount, reason: input.reason, payments: parts.map((p) => ({ paymentId: p.payment.id, method: p.payment.method, amount: p.amount })), restock: input.restockItems ?? [] },
  });
  return { ...(await getTransactionUnchecked(ctx, id)), replayed: false };
}
