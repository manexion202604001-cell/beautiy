import { sql } from 'kysely';
import { assertShopAccess, can, requireAnyPermission, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { toCsv } from '../../lib/csv.js';
import { Errors } from '../../lib/errors.js';
import { dayBounds } from '../../lib/time.js';
import { CAPTURED, loadPosShop, METHOD_LABELS, SOLD_STATUSES } from './common.js';
import type { ListTransactionsInput } from './schemas.js';
import { filterTz, txFilters } from './transactions.js';

const EXPORT_LIMIT = 50_000;

/**
 * 日報 (daily report). Staff with sales.read see the whole shop; staff with only sales.read_own
 * see their own allocated sales (scope 'own').
 */
export async function dailyReport(ctx: Ctx, input: { shopId: string; date: string }) {
  requirePermission(ctx.actor, 'pos.read');
  requireAnyPermission(ctx.actor, 'sales.read', 'sales.read_own');
  assertShopAccess(ctx.actor, input.shopId);
  const shop = await loadPosShop(ctx, input.shopId);
  const { start, end } = dayBounds(input.date, shop.timezone);
  const full = can(ctx.actor, 'sales.read');
  const ownStaffId = ctx.actor.kind === 'staff' ? ctx.actor.staffId : null;
  if (!full && !ownStaffId) throw Errors.forbidden();

  const sold = (qb: any) => qb.where('t.shop_id', '=', input.shopId).where('t.status', 'in', [...SOLD_STATUSES]).where('t.completed_at', '>=', start).where('t.completed_at', '<', end);

  let staffQ = ctx.trx
    .selectFrom('transaction_item_staff as tis')
    .innerJoin('transaction_items as ti', 'ti.id', 'tis.transaction_item_id')
    .innerJoin('transactions as t', 't.id', 'ti.transaction_id')
    .innerJoin('staffs as s', 's.id', 'tis.staff_id')
    .select([
      'tis.staff_id',
      's.display_name',
      sql<number>`sum(tis.allocated_amount)::int`.as('sales'),
      sql<number>`coalesce(sum(tis.allocated_amount) FILTER (WHERE ti.item_type IN ('service','nomination_fee')), 0)::int`.as('service_sales'),
      sql<number>`coalesce(sum(tis.allocated_amount) FILTER (WHERE ti.item_type = 'product'), 0)::int`.as('product_sales'),
      sql<number>`count(DISTINCT t.id)::int`.as('transactions'),
      sql<number>`count(DISTINCT t.id) FILTER (WHERE tis.is_nominated)::int`.as('nominated'),
      sql<number>`count(DISTINCT t.id) FILTER (WHERE t.is_new_customer)::int`.as('new_customers'),
    ])
    .groupBy(['tis.staff_id', 's.display_name'])
    .orderBy('sales', 'desc');
  staffQ = sold(staffQ);
  if (!full) staffQ = staffQ.where('tis.staff_id', '=', ownStaffId!);
  const byStaff = (await staffQ.execute()).map((r) => ({
    staffId: r.staff_id,
    name: r.display_name,
    sales: r.sales,
    serviceSales: r.service_sales,
    productSales: r.product_sales,
    transactions: r.transactions,
    nominatedCount: r.nominated,
    newCustomers: r.new_customers,
  }));
  if (!full) return { scope: 'own' as const, shopId: input.shopId, date: input.date, byStaff };

  type Totals = Record<'count' | 'subtotal' | 'discounts' | 'sales' | 'tax' | 'points_used' | 'points_earned' | 'new_customers' | 'repeat_customers' | 'walk_ins' | 'nominated', number>;
  const totals: Totals = await sold(
    ctx.trx
      .selectFrom('transactions as t')
      .select([
        sql<number>`count(*)::int`.as('count'),
        sql<number>`coalesce(sum(t.subtotal), 0)::int`.as('subtotal'),
        sql<number>`coalesce(sum(t.discount_total), 0)::int`.as('discounts'),
        sql<number>`coalesce(sum(t.total), 0)::int`.as('sales'),
        sql<number>`coalesce(sum(t.tax_total), 0)::int`.as('tax'),
        sql<number>`coalesce(sum(t.point_used), 0)::int`.as('points_used'),
        sql<number>`coalesce(sum(t.point_earned), 0)::int`.as('points_earned'),
        sql<number>`count(*) FILTER (WHERE t.is_new_customer IS TRUE)::int`.as('new_customers'),
        sql<number>`count(*) FILTER (WHERE t.is_new_customer IS FALSE)::int`.as('repeat_customers'),
        sql<number>`count(*) FILTER (WHERE t.customer_id IS NULL)::int`.as('walk_ins'),
        sql<number>`count(*) FILTER (WHERE t.is_nominated)::int`.as('nominated'),
      ]),
  ).executeTakeFirstOrThrow();

  const txRows = await sold(ctx.trx.selectFrom('transactions as t').select(['t.tax_breakdown'])).execute();
  const taxByRate: Record<string, { taxable: number; tax: number }> = {};
  for (const r of txRows as { tax_breakdown: Record<string, { taxable: number; tax: number }> }[]) {
    for (const [rate, b] of Object.entries(r.tax_breakdown ?? {})) {
      taxByRate[rate] ??= { taxable: 0, tax: 0 };
      taxByRate[rate].taxable += b.taxable;
      taxByRate[rate].tax += b.tax;
    }
  }

  const methods = await sold(
    ctx.trx
      .selectFrom('payments as p')
      .innerJoin('transactions as t', 't.id', 'p.transaction_id')
      .leftJoin('custom_payment_methods as cm', 'cm.id', 'p.custom_method_id')
      .select(['p.method', 'cm.name as custom_name', sql<number>`sum(p.amount)::int`.as('amount'), sql<number>`count(*)::int`.as('count')])
      .where('p.status', 'in', [...CAPTURED])
      .groupBy(['p.method', 'cm.name']),
  ).execute();

  // refunds performed during the day (regardless of the original sale date)
  const refunds = await ctx.trx
    .selectFrom('refunds as r')
    .innerJoin('payments as p', 'p.id', 'r.payment_id')
    .innerJoin('transactions as t', 't.id', 'p.transaction_id')
    .select(['p.method', sql<number>`sum(r.amount)::int`.as('amount'), sql<number>`count(DISTINCT t.id)::int`.as('transactions')])
    .where('t.shop_id', '=', input.shopId)
    .where('t.status', '!=', 'voided')
    .where('r.status', '!=', 'failed')
    .where('r.created_at', '>=', start)
    .where('r.created_at', '<', end)
    .groupBy('p.method')
    .execute();
  const refundTotal = refunds.reduce((s, r) => s + r.amount, 0);

  const voided = await ctx.trx
    .selectFrom('transactions')
    .select([sql<number>`count(*)::int`.as('count'), sql<number>`coalesce(sum(total), 0)::int`.as('amount')])
    .where('shop_id', '=', input.shopId)
    .where('status', '=', 'voided')
    .where('completed_at', 'is not', null)
    .where('voided_at', '>=', start)
    .where('voided_at', '<', end)
    .executeTakeFirstOrThrow();

  const sessions = await ctx.trx
    .selectFrom('register_sessions')
    .select(['id', 'status', 'opened_at', 'closed_at', 'opening_cash', 'expected_cash', 'counted_cash', 'difference'])
    .where('shop_id', '=', input.shopId)
    .where('opened_at', '<', end)
    .where((eb) => eb.or([eb('closed_at', 'is', null), eb('closed_at', '>=', start)]))
    .orderBy('opened_at')
    .execute();

  return {
    scope: 'shop' as const,
    shopId: input.shopId,
    date: input.date,
    totals: {
      transactionCount: totals.count,
      subtotal: totals.subtotal,
      discountTotal: totals.discounts,
      grossSales: totals.sales,
      refundTotal,
      netSales: totals.sales - refundTotal,
      taxTotal: totals.tax,
      pointsUsed: totals.points_used,
      pointsEarned: totals.points_earned,
      averageSpend: totals.count ? Math.round(totals.sales / totals.count) : 0,
    },
    customers: { new: totals.new_customers, repeat: totals.repeat_customers, walkIn: totals.walk_ins, nominated: totals.nominated },
    taxByRate,
    byMethod: (methods as { method: string; custom_name: string | null; amount: number; count: number }[]).map((m) => ({ method: m.method, label: m.method === 'custom' ? (m.custom_name ?? METHOD_LABELS.custom!) : (METHOD_LABELS[m.method] ?? m.method), amount: m.amount, count: m.count })),
    refunds: refunds.map((r) => ({ method: r.method, amount: r.amount, transactions: r.transactions })),
    voided: { count: voided.count, amount: voided.amount },
    byStaff,
    register: sessions.map((s) => ({ ...s })),
    registerDifference: sessions.reduce((sum, s) => sum + (s.difference ?? 0), 0),
  };
}

// ------------------------------------------------------------------------------- CSV exports

export async function exportTransactionsCsv(ctx: Ctx, input: Omit<ListTransactionsInput, 'cursor' | 'limit'>) {
  requirePermission(ctx.actor, 'pos.read', 'export.data');
  const tz = await filterTz(ctx, input.shopId);
  let q = ctx.trx
    .selectFrom('transactions as t')
    .innerJoin('shops as sh', 'sh.id', 't.shop_id')
    .leftJoin('customers as c', 'c.id', 't.customer_id')
    .leftJoin('staffs as s', 's.id', 't.staff_id')
    .select([
      't.id',
      't.transaction_number',
      'sh.name as shop_name',
      't.status',
      't.completed_at',
      't.customer_id',
      sql<string | null>`CASE WHEN c.id IS NULL THEN NULL ELSE trim(c.last_name || ' ' || c.first_name) END`.as('customer_name'),
      's.display_name as staff_name',
      't.is_nominated',
      't.is_new_customer',
      't.subtotal',
      't.discount_total',
      't.total',
      't.tax_total',
      't.tax_breakdown',
      't.paid_total',
      't.refunded_total',
      't.point_used',
      't.point_earned',
      't.appointment_id',
      't.voided_at',
      't.void_reason',
    ])
    .orderBy('t.created_at')
    .limit(EXPORT_LIMIT);
  q = txFilters(ctx, input, tz)(q);
  const rows = await q.execute();
  const ids = rows.map((r) => r.id);
  const pays = ids.length
    ? await ctx.trx
        .selectFrom('payments')
        .select(['transaction_id', 'method', sql<number>`sum(amount)::int`.as('amount')])
        .where('transaction_id', 'in', ids)
        .where('status', 'in', [...CAPTURED])
        .groupBy(['transaction_id', 'method'])
        .execute()
    : [];
  const out = rows.map((r) => {
    const tb = (r.tax_breakdown ?? {}) as Record<string, { taxable: number; tax: number }>;
    const p = (m: string) => pays.filter((x) => x.transaction_id === r.id && x.method === m).reduce((s, x) => s + x.amount, 0);
    return {
      ...r,
      completed_at: r.completed_at ? r.completed_at.toISOString() : '',
      taxable_10: tb['1000']?.taxable ?? 0,
      tax_10: tb['1000']?.tax ?? 0,
      taxable_8: tb['800']?.taxable ?? 0,
      tax_8: tb['800']?.tax ?? 0,
      pay_cash: p('cash'),
      pay_card: p('card') + p('online'),
      pay_emoney: p('emoney'),
      pay_qr: p('qr'),
      pay_custom: p('custom'),
      pay_point: p('point'),
      is_nominated: r.is_nominated ? '指名' : 'フリー',
      is_new_customer: r.is_new_customer === null ? '' : r.is_new_customer ? '新規' : '再来',
    };
  });
  await audit(ctx, { action: 'export.csv', resourceType: 'transaction', shopId: input.shopId ?? null, metadata: { kind: 'transactions', filters: input, count: rows.length } });
  return toCsv(
    [
      { key: 'transaction_number', label: '会計番号' },
      { key: 'shop_name', label: '店舗' },
      { key: 'status', label: '状態' },
      { key: 'completed_at', label: '会計日時' },
      { key: 'customer_id', label: '顧客ID' },
      { key: 'customer_name', label: '顧客名' },
      { key: 'staff_name', label: '主担当' },
      { key: 'is_nominated', label: '指名/フリー' },
      { key: 'is_new_customer', label: '新規/再来' },
      { key: 'subtotal', label: '小計(税込)' },
      { key: 'discount_total', label: '値引' },
      { key: 'total', label: '合計(税込)' },
      { key: 'tax_total', label: '内消費税' },
      { key: 'taxable_10', label: '10%対象' },
      { key: 'tax_10', label: '10%税額' },
      { key: 'taxable_8', label: '8%対象' },
      { key: 'tax_8', label: '8%税額' },
      { key: 'pay_cash', label: '現金' },
      { key: 'pay_card', label: 'カード' },
      { key: 'pay_emoney', label: '電子マネー' },
      { key: 'pay_qr', label: 'QR' },
      { key: 'pay_custom', label: '店舗独自' },
      { key: 'pay_point', label: 'ポイント' },
      { key: 'refunded_total', label: '返金額' },
      { key: 'point_earned', label: '付与ポイント' },
      { key: 'void_reason', label: '取消理由' },
      { key: 'id', label: '会計ID' },
    ],
    out,
  );
}

export async function exportTransactionItemsCsv(ctx: Ctx, input: Omit<ListTransactionsInput, 'cursor' | 'limit'>) {
  requirePermission(ctx.actor, 'pos.read', 'export.data');
  const tz = await filterTz(ctx, input.shopId);
  let q = ctx.trx
    .selectFrom('transaction_items as ti')
    .innerJoin('transactions as t', 't.id', 'ti.transaction_id')
    .leftJoin('transaction_item_staff as tis', 'tis.transaction_item_id', 'ti.id')
    .leftJoin('staffs as s', 's.id', 'tis.staff_id')
    .select([
      't.transaction_number',
      't.completed_at',
      't.status',
      'ti.id as item_id',
      'ti.item_type',
      'ti.name',
      'ti.menu_id',
      'ti.product_id',
      'ti.coupon_id',
      'ti.quantity',
      'ti.unit_price',
      'ti.line_discount',
      'ti.amount',
      'ti.allocated_discount',
      'ti.net_amount',
      'ti.tax_rate_bp',
      'ti.tax_amount',
      's.display_name as staff_name',
      'tis.staff_id',
      'tis.role',
      'tis.share_bp',
      'tis.is_nominated',
      'tis.allocated_amount',
    ])
    .orderBy('t.created_at')
    .orderBy('ti.sort_order')
    .limit(EXPORT_LIMIT);
  q = txFilters(ctx, input, tz)(q);
  const rows = await q.execute();
  await audit(ctx, { action: 'export.csv', resourceType: 'transaction_item', shopId: input.shopId ?? null, metadata: { kind: 'transaction_items', filters: input, count: rows.length } });
  return toCsv(
    [
      { key: 'transaction_number', label: '会計番号' },
      { key: 'completed_at', label: '会計日時' },
      { key: 'status', label: '状態' },
      { key: 'item_type', label: '区分' },
      { key: 'name', label: '品目' },
      { key: 'quantity', label: '数量' },
      { key: 'unit_price', label: '単価(税込)' },
      { key: 'line_discount', label: '明細値引' },
      { key: 'amount', label: '金額(税込)' },
      { key: 'allocated_discount', label: '按分値引' },
      { key: 'net_amount', label: '純売上(税込)' },
      { key: 'tax_rate_bp', label: '税率(bp)' },
      { key: 'tax_amount', label: '内消費税' },
      { key: 'staff_name', label: '担当' },
      { key: 'role', label: '役割' },
      { key: 'share_bp', label: '配分(bp)' },
      { key: 'is_nominated', label: '指名' },
      { key: 'allocated_amount', label: '配賦売上' },
      { key: 'menu_id', label: 'メニューID' },
      { key: 'product_id', label: '商品ID' },
      { key: 'coupon_id', label: 'クーポンID' },
      { key: 'item_id', label: '明細ID' },
    ],
    rows.map((r) => ({ ...r, completed_at: r.completed_at ? r.completed_at.toISOString() : '' })),
  );
}
