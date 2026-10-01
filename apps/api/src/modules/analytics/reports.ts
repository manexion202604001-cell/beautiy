import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { assertShopAccess, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { dateRange, dayBounds, localDate } from '../../lib/time.js';
import { computeDay, NO_APPOINTMENT_SOURCE, scheduleRebuild, VISIT_STATUSES } from './aggregate.js';
import type { ChannelsQuery, DashboardQuery, MenusQuery, RebuildBody, SalesQuery, StaffQuery } from './schemas.js';
import {
  assertOwnStaff,
  auditSalesView,
  bucketKey,
  bucketKeys,
  compareRange,
  daysBetween,
  deltas,
  delta,
  pct,
  ratio,
  requireFullScope,
  resolveRange,
  resolveScope,
  round1,
  type DateRange,
  type Scope,
} from './scope.js';

// ---------------------------------------------------------------- loaders

interface ShopAgg {
  salesTotal: number;
  serviceSales: number;
  productSales: number;
  discountTotal: number;
  taxTotal: number;
  refundTotal: number;
  transactionCount: number;
  customerCount: number;
  newCustomerCount: number;
  repeatCustomerCount: number;
  nominatedCount: number;
}

const emptyShopAgg = (): ShopAgg => ({
  salesTotal: 0,
  serviceSales: 0,
  productSales: 0,
  discountTotal: 0,
  taxTotal: 0,
  refundTotal: 0,
  transactionCount: 0,
  customerCount: 0,
  newCustomerCount: 0,
  repeatCustomerCount: 0,
  nominatedCount: 0,
});

async function loadShopDays(ctx: Ctx, shopIds: string[], range: DateRange) {
  return ctx.trx
    .selectFrom('analytics_daily_shop')
    .selectAll()
    .where('shop_id', 'in', shopIds)
    .where('date', '>=', range.from)
    .where('date', '<=', range.to)
    .execute();
}

type ShopDay = Awaited<ReturnType<typeof loadShopDays>>[number];

function addShopDay(acc: ShopAgg, r: ShopDay) {
  acc.salesTotal += r.sales_total;
  acc.serviceSales += r.service_sales;
  acc.productSales += r.product_sales;
  acc.discountTotal += r.discount_total;
  acc.taxTotal += r.tax_total;
  acc.refundTotal += r.refund_total;
  acc.transactionCount += r.transaction_count;
  acc.customerCount += r.customer_count;
  acc.newCustomerCount += r.new_customer_count;
  acc.repeatCustomerCount += r.repeat_customer_count;
  acc.nominatedCount += r.nominated_count;
}

/** 客単価 = 純売上 ÷ 延べ来店客数, plus derived rates */
function finishShopAgg(a: ShopAgg) {
  return {
    ...a,
    avgTicket: ratio(a.salesTotal, a.customerCount),
    avgTransactionValue: ratio(a.salesTotal, a.transactionCount),
    nominatedRate: pct(a.nominatedCount, a.transactionCount),
    newCustomerRate: pct(a.newCustomerCount, a.newCustomerCount + a.repeatCustomerCount),
  };
}

interface StaffAgg {
  salesTotal: number;
  serviceSales: number;
  productSales: number;
  customerCount: number;
  newCustomerCount: number;
  nominatedCount: number;
  scheduledMinutes: number;
  bookedMinutes: number;
}

const emptyStaffAgg = (): StaffAgg => ({
  salesTotal: 0,
  serviceSales: 0,
  productSales: 0,
  customerCount: 0,
  newCustomerCount: 0,
  nominatedCount: 0,
  scheduledMinutes: 0,
  bookedMinutes: 0,
});

async function loadStaffDays(ctx: Ctx, shopIds: string[], range: DateRange, staffId?: string | null) {
  let q = ctx.trx
    .selectFrom('analytics_daily_staff')
    .selectAll()
    .where('shop_id', 'in', shopIds)
    .where('date', '>=', range.from)
    .where('date', '<=', range.to);
  if (staffId) q = q.where('staff_id', '=', staffId);
  return q.execute();
}

type StaffDay = Awaited<ReturnType<typeof loadStaffDays>>[number];

function addStaffDay(acc: StaffAgg, r: StaffDay) {
  acc.salesTotal += r.sales_total;
  acc.serviceSales += r.service_sales;
  acc.productSales += r.product_sales;
  acc.customerCount += r.customer_count;
  acc.newCustomerCount += r.new_customer_count;
  acc.nominatedCount += r.nominated_count;
  acc.scheduledMinutes += r.scheduled_minutes;
  acc.bookedMinutes += r.booked_minutes;
}

function finishStaffAgg(a: StaffAgg) {
  return {
    ...a,
    avgTicket: ratio(a.salesTotal, a.customerCount),
    nominatedRate: pct(a.nominatedCount, a.customerCount),
    bookedHours: round1(a.bookedMinutes / 60),
    scheduledHours: round1(a.scheduledMinutes / 60),
    salesPerBookedHour: ratio(a.salesTotal * 60, a.bookedMinutes),
    salesPerScheduledHour: ratio(a.salesTotal * 60, a.scheduledMinutes),
    utilization: pct(a.bookedMinutes, a.scheduledMinutes),
  };
}

async function staffNames(ctx: Ctx, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await ctx.trx.selectFrom('staffs').select(['id', 'display_name']).where('id', 'in', ids).execute();
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

function rangeInfo(range: DateRange) {
  return { ...range, days: daysBetween(range.from, range.to) + 1 };
}

// ---------------------------------------------------------------- sales

/**
 * GET /analytics/sales — 売上 (総額/施術/店販/値引/税/件数/客単価), period buckets or shop/staff rows,
 * with comparison deltas. Stylists (analytics.read_own / sales.read_own) see their own staff figures only.
 */
export async function salesReport(ctx: Ctx, input: SalesQuery) {
  const scope = await resolveScope(ctx, input.shopId, { full: ['analytics.read', 'sales.read'], own: ['analytics.read_own', 'sales.read_own'] });
  assertOwnStaff(scope, input.staffId);
  if (scope.ownStaffId && input.groupBy === 'shop') requireFullScope(scope, '店舗別売上');
  const range = resolveRange(input, scope.tz);
  const cmp = compareRange(range, input.compareTo);
  const staffId = scope.ownStaffId ?? input.staffId ?? null;
  const staffLevel = !!staffId || input.groupBy === 'staff';

  let result;
  if (!staffLevel) {
    const [cur, prev] = await Promise.all([loadShopDays(ctx, scope.shopIds, range), cmp ? loadShopDays(ctx, scope.shopIds, cmp) : []]);
    const sum = (rows: ShopDay[]) => {
      const a = emptyShopAgg();
      rows.forEach((r) => addShopDay(a, r));
      return finishShopAgg(a);
    };
    const summary = sum(cur);
    const previous = cmp ? sum(prev) : null;
    let rows: Record<string, unknown>[];
    if (input.groupBy === 'shop') {
      rows = scope.shops.map((s) => {
        const c = sum(cur.filter((r) => r.shop_id === s.id));
        const p = cmp ? sum(prev.filter((r) => r.shop_id === s.id)) : null;
        return { key: s.id, label: s.name, shopId: s.id, ...c, previousSalesTotal: p?.salesTotal ?? null, salesDelta: p ? delta(c.salesTotal, p.salesTotal) : null };
      });
    } else {
      const g = input.groupBy as 'day' | 'week' | 'month';
      rows = bucketKeys(range, g).map((k) => ({ key: k, label: k, period: k, ...sum(cur.filter((r) => bucketKey(r.date, g) === k)) }));
    }
    result = {
      level: 'shop' as const,
      summary,
      comparison: previous && cmp ? { range: rangeInfo(cmp), summary: previous, deltas: deltas(numeric(summary), numeric(previous)) } : null,
      rows,
    };
  } else {
    const [cur, prev] = await Promise.all([loadStaffDays(ctx, scope.shopIds, range, staffId), cmp ? loadStaffDays(ctx, scope.shopIds, cmp, staffId) : []]);
    const sum = (rows: StaffDay[]) => {
      const a = emptyStaffAgg();
      rows.forEach((r) => addStaffDay(a, r));
      return finishStaffAgg(a);
    };
    const summary = sum(cur);
    const previous = cmp ? sum(prev) : null;
    let rows: Record<string, unknown>[];
    if (input.groupBy === 'staff' || input.groupBy === 'shop') {
      const ids = [...new Set([...cur.map((r) => r.staff_id), ...prev.map((r) => r.staff_id)])];
      const names = await staffNames(ctx, ids);
      rows = ids
        .map((id) => {
          const c = sum(cur.filter((r) => r.staff_id === id));
          const p = cmp ? sum(prev.filter((r) => r.staff_id === id)) : null;
          return { key: id, label: names.get(id) ?? '', staffId: id, ...c, previousSalesTotal: p?.salesTotal ?? null, salesDelta: p ? delta(c.salesTotal, p.salesTotal) : null };
        })
        .filter((r) => r.salesTotal !== 0 || r.customerCount > 0 || (r.previousSalesTotal ?? 0) !== 0)
        .sort((a, b) => b.salesTotal - a.salesTotal);
    } else {
      const g = input.groupBy;
      rows = bucketKeys(range, g).map((k) => ({ key: k, label: k, period: k, ...sum(cur.filter((r) => bucketKey(r.date, g) === k)) }));
    }
    result = {
      level: 'staff' as const,
      staffId,
      summary,
      comparison: previous && cmp ? { range: rangeInfo(cmp), summary: previous, deltas: deltas(numeric(summary), numeric(previous)) } : null,
      rows,
    };
  }
  await auditSalesView(ctx, 'sales', scope, { range, groupBy: input.groupBy, staffId, compareTo: input.compareTo });
  return { range: rangeInfo(range), shopIds: scope.shops.map((s) => s.id), groupBy: input.groupBy, compareTo: input.compareTo, ...result };
}

function numeric(o: Record<string, unknown>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(o)) if (typeof v === 'number' || v === null) out[k] = v as number | null;
  return out;
}

// ---------------------------------------------------------------- staff productivity

/** GET /analytics/staff — スタッフ生産性 (売上, 客数, 指名率, 新規数, 稼働時間あたり売上, 稼働率) */
export async function staffReport(ctx: Ctx, input: StaffQuery) {
  const scope = await resolveScope(ctx, input.shopId, { full: ['analytics.read'], own: ['analytics.read_own'] });
  assertOwnStaff(scope, input.staffId);
  const range = resolveRange(input, scope.tz);
  const cmp = compareRange(range, input.compareTo);
  const staffId = scope.ownStaffId ?? input.staffId ?? null;
  const [cur, prev] = await Promise.all([loadStaffDays(ctx, scope.shopIds, range, staffId), cmp ? loadStaffDays(ctx, scope.shopIds, cmp, staffId) : []]);
  const ids = [...new Set(cur.map((r) => r.staff_id))];
  const names = await staffNames(ctx, ids);
  const sum = (rows: StaffDay[]) => {
    const a = emptyStaffAgg();
    rows.forEach((r) => addStaffDay(a, r));
    return finishStaffAgg(a);
  };
  const rows = ids
    .map((id) => {
      const c = sum(cur.filter((r) => r.staff_id === id));
      const p = cmp ? sum(prev.filter((r) => r.staff_id === id)) : null;
      return {
        staffId: id,
        staffName: names.get(id) ?? '',
        ...c,
        previous: p ? { salesTotal: p.salesTotal, customerCount: p.customerCount, nominatedRate: p.nominatedRate, utilization: p.utilization } : null,
        salesDelta: p ? delta(c.salesTotal, p.salesTotal) : null,
      };
    })
    .sort((a, b) => b.salesTotal - a.salesTotal || a.staffName.localeCompare(b.staffName));
  await auditSalesView(ctx, 'staff', scope, { range, staffId });
  return {
    range: rangeInfo(range),
    shopIds: scope.shops.map((s) => s.id),
    compareTo: input.compareTo,
    comparisonRange: cmp ? rangeInfo(cmp) : null,
    ownOnly: !!scope.ownStaffId,
    rows,
  };
}

// ---------------------------------------------------------------- menus

/** GET /analytics/menus — メニュー構成比 (件数・売上シェア、メニュー別/カテゴリ別) */
export async function menusReport(ctx: Ctx, input: MenusQuery) {
  const scope = await resolveScope(ctx, input.shopId, { full: ['analytics.read'] });
  const range = resolveRange(input, scope.tz);
  const cmp = compareRange(range, input.compareTo);
  const load = (r: DateRange) =>
    ctx.trx
      .selectFrom('analytics_daily_menu as m')
      .innerJoin('menus', 'menus.id', 'm.menu_id')
      .leftJoin('menu_categories as c', 'c.id', 'menus.category_id')
      .select([
        'm.menu_id',
        'menus.name as menu_name',
        'menus.category_id',
        'c.name as category_name',
        sql<number>`sum(m.count)::int`.as('count'),
        sql<number>`sum(m.sales)::bigint`.as('sales'),
      ])
      .where('m.shop_id', 'in', scope.shopIds)
      .where('m.date', '>=', r.from)
      .where('m.date', '<=', r.to)
      .groupBy(['m.menu_id', 'menus.name', 'menus.category_id', 'c.name'])
      .execute();
  const [cur, prev] = await Promise.all([load(range), cmp ? load(cmp) : []]);
  const totalCount = cur.reduce((s, r) => s + r.count, 0);
  const totalSales = cur.reduce((s, r) => s + r.sales, 0);
  const prevCount = prev.reduce((s, r) => s + r.count, 0);
  const prevSales = prev.reduce((s, r) => s + r.sales, 0);
  const menus = cur
    .map((r) => {
      const p = prev.find((x) => x.menu_id === r.menu_id);
      return {
        menuId: r.menu_id,
        menuName: r.menu_name,
        categoryId: r.category_id,
        categoryName: r.category_name ?? '未分類',
        count: r.count,
        sales: r.sales,
        countShare: pct(r.count, totalCount),
        salesShare: pct(r.sales, totalSales),
        avgPrice: ratio(r.sales, r.count),
        previousCount: cmp ? (p?.count ?? 0) : null,
        previousSales: cmp ? (p?.sales ?? 0) : null,
        salesDelta: cmp ? delta(r.sales, p?.sales ?? 0) : null,
      };
    })
    .sort((a, b) => b.sales - a.sales || b.count - a.count);
  const catMap = new Map<string, { categoryId: string | null; categoryName: string; count: number; sales: number }>();
  for (const m of menus) {
    const key = m.categoryId ?? 'none';
    const c = catMap.get(key) ?? { categoryId: m.categoryId, categoryName: m.categoryName, count: 0, sales: 0 };
    c.count += m.count;
    c.sales += m.sales;
    catMap.set(key, c);
  }
  const categories = [...catMap.values()]
    .map((c) => ({ ...c, countShare: pct(c.count, totalCount), salesShare: pct(c.sales, totalSales) }))
    .sort((a, b) => b.sales - a.sales);
  await auditSalesView(ctx, 'menus', scope, { range });
  return {
    range: rangeInfo(range),
    shopIds: scope.shops.map((s) => s.id),
    compareTo: input.compareTo,
    summary: { totalCount, totalSales },
    comparison: cmp
      ? { range: rangeInfo(cmp), summary: { totalCount: prevCount, totalSales: prevSales }, deltas: { totalCount: delta(totalCount, prevCount), totalSales: delta(totalSales, prevSales) } }
      : null,
    menus,
    categories,
  };
}

// ---------------------------------------------------------------- channels

export const SOURCE_LABELS: Record<string, string> = {
  web: 'Web予約',
  line: 'LINE予約',
  external: '外部予約媒体',
  phone: '電話',
  walk_in: '飛び込み',
  staff: 'スタッフ登録',
  [NO_APPOINTMENT_SOURCE]: '予約なし(直接会計)',
};

/** GET /analytics/channels — 予約経路別 予約数・来店完了数・売上 */
export async function channelsReport(ctx: Ctx, input: ChannelsQuery) {
  const scope = await resolveScope(ctx, input.shopId, { full: ['analytics.read'] });
  const range = resolveRange(input, scope.tz);
  const cmp = compareRange(range, input.compareTo);
  const load = (r: DateRange) =>
    ctx.trx
      .selectFrom('analytics_daily_source')
      .select([
        'source',
        sql<number>`sum(appointment_count)::int`.as('appointment_count'),
        sql<number>`sum(completed_count)::int`.as('completed_count'),
        sql<number>`sum(sales)::bigint`.as('sales'),
      ])
      .where('shop_id', 'in', scope.shopIds)
      .where('date', '>=', r.from)
      .where('date', '<=', r.to)
      .groupBy('source')
      .execute();
  const [cur, prev] = await Promise.all([load(range), cmp ? load(cmp) : []]);
  const totalSales = cur.reduce((s, r) => s + r.sales, 0);
  const totalAppointments = cur.reduce((s, r) => s + r.appointment_count, 0);
  const rows = cur
    .map((r) => {
      const p = prev.find((x) => x.source === r.source);
      return {
        source: r.source,
        label: SOURCE_LABELS[r.source] ?? r.source,
        appointmentCount: r.appointment_count,
        completedCount: r.completed_count,
        completionRate: pct(r.completed_count, r.appointment_count),
        appointmentShare: pct(r.appointment_count, totalAppointments),
        sales: r.sales,
        salesShare: pct(r.sales, totalSales),
        salesPerCompleted: ratio(r.sales, r.completed_count),
        previousSales: cmp ? (p?.sales ?? 0) : null,
        salesDelta: cmp ? delta(r.sales, p?.sales ?? 0) : null,
      };
    })
    .filter((r) => r.appointmentCount || r.sales || r.previousSales)
    .sort((a, b) => b.sales - a.sales || b.appointmentCount - a.appointmentCount);
  await auditSalesView(ctx, 'channels', scope, { range });
  return {
    range: rangeInfo(range),
    shopIds: scope.shops.map((s) => s.id),
    compareTo: input.compareTo,
    comparisonRange: cmp ? rangeInfo(cmp) : null,
    summary: { totalSales, totalAppointments },
    rows,
  };
}

// ---------------------------------------------------------------- dashboard

const PENDING_APPT_STATUSES = ['tentative', 'confirmed', 'checked_in', 'in_service', 'completed'] as const;

function monthlyTarget(settings: unknown, shopId: string): number | null {
  const s = (settings ?? {}) as { monthlyTargets?: Record<string, unknown>; monthlyTarget?: unknown };
  const perShop = s.monthlyTargets?.[shopId];
  if (typeof perShop === 'number' && perShop > 0) return perShop;
  if (typeof s.monthlyTarget === 'number' && s.monthlyTarget > 0) return s.monthlyTarget;
  return null;
}

async function dashboardShop(ctx: Ctx, shop: Scope['shops'][number], date: string, settings: unknown) {
  const monthStart = `${date.slice(0, 7)}-01`;
  const daysInMonth = DateTime.fromISO(date).daysInMonth ?? 30;
  const dayOfMonth = Number(date.slice(8, 10));
  const live = await computeDay(ctx, shop.id, date, { skipSchedule: true });
  const { start, end } = dayBounds(date, shop.timezone);
  const appts = await ctx.trx
    .selectFrom('appointments')
    .select([
      'status',
      sql<number>`count(*)::int`.as('n'),
      sql<number>`coalesce(sum(estimated_total) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM transactions t WHERE t.appointment_id = appointments.id AND t.status IN ('completed','partially_refunded','refunded')
      )), 0)::bigint`.as('pending_estimate'),
    ])
    .where('shop_id', '=', shop.id)
    .where('deleted_at', 'is', null)
    .where('start_at', '>=', start)
    .where('start_at', '<', end)
    .groupBy('status')
    .execute();
  const byStatus: Record<string, number> = { tentative: 0, confirmed: 0, checked_in: 0, in_service: 0, completed: 0, cancelled: 0, no_show: 0 };
  let pendingEstimate = 0;
  for (const a of appts) {
    byStatus[a.status] = a.n;
    if ((PENDING_APPT_STATUSES as readonly string[]).includes(a.status)) pendingEstimate += a.pending_estimate;
  }
  const activeAppointments = PENDING_APPT_STATUSES.reduce((s, k) => s + (byStatus[k] ?? 0), 0);

  const past = monthStart < date ? await loadShopDays(ctx, [shop.id], { from: monthStart, to: addDays(date, -1) }) : [];
  const mtdSales = past.reduce((s, r) => s + r.sales_total, 0) + live.shop.sales_total;
  const mtdCustomers = past.reduce((s, r) => s + r.customer_count, 0) + live.shop.customer_count;
  const target = monthlyTarget(settings, shop.id);
  return {
    shopId: shop.id,
    shopName: shop.name,
    today: {
      appointments: activeAppointments,
      appointmentsByStatus: byStatus,
      expectedSales: live.shop.sales_total + pendingEstimate,
      completedSales: live.shop.sales_total,
      transactions: live.shop.transaction_count,
      customers: live.shop.customer_count,
      newCustomers: live.shop.new_customer_count,
      cancellations: byStatus.cancelled ?? 0,
      noShows: byStatus.no_show ?? 0,
    },
    monthToDate: {
      from: monthStart,
      to: date,
      sales: mtdSales,
      customers: mtdCustomers,
      target,
      achievementRate: target ? pct(mtdSales, target) : null,
      paceRate: target ? pct(mtdSales, (target * dayOfMonth) / daysInMonth) : null,
      remainingToTarget: target ? Math.max(0, target - mtdSales) : null,
    },
  };
}

/**
 * GET /analytics/dashboard — 本日のKPI (live for today) + 月初来累計 vs 月間目標.
 * Month-to-date = aggregates (1st .. date−1) + live computation of `date`.
 * Target: organizations.settings.monthlyTargets[shopId] (fallback settings.monthlyTarget).
 */
export async function dashboard(ctx: Ctx, input: DashboardQuery) {
  const shopId = input.shopId ?? ctx.meta.currentShopId ?? undefined;
  const scope = await resolveScope(ctx, shopId, { full: ['analytics.read'] });
  const date = input.date ?? localDate(new Date(), scope.tz);
  const org = await ctx.trx.selectFrom('organizations').select('settings').where('id', '=', ctx.actor.organizationId).executeTakeFirstOrThrow();

  const daysInMonth = DateTime.fromISO(date).daysInMonth ?? 30;
  const dayOfMonth = Number(date.slice(8, 10));

  const shops: Awaited<ReturnType<typeof dashboardShop>>[] = [];
  for (const shop of scope.shops) shops.push(await dashboardShop(ctx, shop, date, org.settings));
  const sumOf = (f: (s: (typeof shops)[number]) => number) => shops.reduce((acc, s) => acc + f(s), 0);
  const targets = shops.map((s) => s.monthToDate.target).filter((t): t is number => t !== null);
  const totalTarget = targets.length ? targets.reduce((a, b) => a + b, 0) : null;
  const total = {
    today: {
      appointments: sumOf((s) => s.today.appointments),
      expectedSales: sumOf((s) => s.today.expectedSales),
      completedSales: sumOf((s) => s.today.completedSales),
      transactions: sumOf((s) => s.today.transactions),
      customers: sumOf((s) => s.today.customers),
      newCustomers: sumOf((s) => s.today.newCustomers),
      cancellations: sumOf((s) => s.today.cancellations),
      noShows: sumOf((s) => s.today.noShows),
    },
    monthToDate: {
      sales: sumOf((s) => s.monthToDate.sales),
      target: totalTarget,
      achievementRate: totalTarget ? pct(sumOf((s) => s.monthToDate.sales), totalTarget) : null,
      paceRate: totalTarget ? pct(sumOf((s) => s.monthToDate.sales), (totalTarget * dayOfMonth) / daysInMonth) : null,
    },
  };
  await auditSalesView(ctx, 'dashboard', scope, { date });
  return { date, shops, total };
}

function addDays(date: string, n: number) {
  return DateTime.fromISO(date).plus({ days: n }).toISODate()!;
}

// ---------------------------------------------------------------- admin rebuild

export async function requestRebuild(ctx: Ctx, input: RebuildBody) {
  requirePermission(ctx.actor, 'ops.manage');
  assertShopAccess(ctx.actor, input.shopId);
  const shop = await ctx.trx.selectFrom('shops').select('id').where('id', '=', input.shopId).executeTakeFirst();
  if (!shop) throw Errors.notFound('店舗', input.shopId);
  if (input.from > input.to) throw Errors.validation('開始日は終了日以前を指定してください');
  const dates = dateRange(input.from, input.to);
  if (dates.length > 400) throw Errors.validation('再集計は最大400日までです');
  const enqueued = await scheduleRebuild(ctx, input.shopId, dates, 0);
  await audit(ctx, { action: 'analytics.rebuild', resourceType: 'shop', resourceId: input.shopId, shopId: input.shopId, metadata: { from: input.from, to: input.to, days: dates.length } });
  return { shopId: input.shopId, from: input.from, to: input.to, days: dates.length, enqueued };
}

export { VISIT_STATUSES, type Scope };
