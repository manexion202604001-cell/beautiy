// Sales / staff / LTV analytics. Aggregations run in Postgres ($queryRaw with bound
// parameters) so they scale with transaction volume; customer-level lifecycle metrics
// reuse the pure rules in @salonos/core (lifecycle, repeatRate).
import { Prisma } from '@salonos/db';
import { addDays, lifecycle, localToUtc, repeatRate, todayIn, toLocalParts, type Lifecycle } from '@salonos/core';
import { prisma } from './db';

// Sales include refunded tickets (refunds are subtracted separately on the refund date).
const SALE_STATUSES = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'];
// A "visit" for customer metrics (matches recomputeCustomerStats).
const VISIT_STATUSES = ['PAID', 'PARTIALLY_REFUNDED'];

// ───────────────────────── Periods ─────────────────────────

export type RangeKey = 'today' | 'yesterday' | '7d' | '30d' | 'thisMonth' | 'lastMonth' | '3m' | '6m' | '12m' | 'thisYear' | 'custom';
export const RANGE_LABEL: Record<RangeKey, string> = {
  today: '今日', yesterday: '昨日', '7d': '直近7日', '30d': '直近30日', thisMonth: '今月', lastMonth: '先月',
  '3m': '直近3ヶ月', '6m': '直近6ヶ月', '12m': '直近12ヶ月', thisYear: '今年', custom: '期間指定',
};

export interface Period {
  range: RangeKey;
  /** inclusive local dates */
  fromDate: string;
  toDate: string;
  /** UTC instants, [from, to) */
  from: Date;
  to: Date;
  tz: string;
  days: number;
}

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const monthStart = (d: string) => d.slice(0, 8) + '01';
function addMonths(d: string, n: number) {
  const [y, m] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return t.toISOString().slice(0, 10);
}

export function makePeriod(fromDate: string, toDate: string, tz: string, range: RangeKey = 'custom'): Period {
  if (toDate < fromDate) [fromDate, toDate] = [toDate, fromDate];
  const days = Math.round((Date.parse(toDate) - Date.parse(fromDate)) / 86400000) + 1;
  return { range, fromDate, toDate, from: localToUtc(fromDate, 0, tz), to: localToUtc(addDays(toDate, 1), 0, tz), tz, days };
}

/** Resolve ?range=&from=&to= into a period (max 3 years for custom ranges). */
export function resolvePeriod(sp: { range?: string; from?: string; to?: string }, tz: string, now = new Date(), fallback: RangeKey = 'thisMonth'): Period {
  const today = todayIn(tz, now);
  const range = (sp.range && sp.range in RANGE_LABEL ? sp.range : isDate(sp.from) && isDate(sp.to) ? 'custom' : fallback) as RangeKey;
  switch (range) {
    case 'today': return makePeriod(today, today, tz, range);
    case 'yesterday': return makePeriod(addDays(today, -1), addDays(today, -1), tz, range);
    case '7d': return makePeriod(addDays(today, -6), today, tz, range);
    case '30d': return makePeriod(addDays(today, -29), today, tz, range);
    case 'thisMonth': return makePeriod(monthStart(today), today, tz, range);
    case 'lastMonth': { const s = addMonths(monthStart(today), -1); return makePeriod(s, addDays(monthStart(today), -1), tz, range); }
    case '3m': return makePeriod(addMonths(monthStart(today), -2), today, tz, range);
    case '6m': return makePeriod(addMonths(monthStart(today), -5), today, tz, range);
    case '12m': return makePeriod(addMonths(monthStart(today), -11), today, tz, range);
    case 'thisYear': return makePeriod(today.slice(0, 4) + '-01-01', today, tz, range);
    case 'custom': {
      let f = isDate(sp.from) ? sp.from : monthStart(today), t = isDate(sp.to) ? sp.to : today;
      if (t < f) [f, t] = [t, f];
      if (Date.parse(t) - Date.parse(f) > 3 * 366 * 86400000) f = addDays(t, -3 * 366);
      return makePeriod(f, t, tz, 'custom');
    }
  }
}

/** The same-length period immediately before (for deltas). */
export function previousPeriod(p: Period): Period {
  if (p.range === 'thisMonth' || p.range === 'lastMonth') {
    // month-to-date vs the same days of the previous month
    const s = addMonths(p.fromDate, -1);
    const lastOfPrev = addDays(p.fromDate, -1);
    const e = addDays(s, p.days - 1) > lastOfPrev ? lastOfPrev : addDays(s, p.days - 1);
    return makePeriod(s, e, p.tz, 'custom');
  }
  return makePeriod(addDays(p.fromDate, -p.days), addDays(p.fromDate, -1), p.tz, 'custom');
}

// ───────────────────────── SQL helpers ─────────────────────────

/** Timestamp columns are `timestamp(3)` in UTC; bind instants as UTC timestamps. */
const ts = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
const saleAt = Prisma.sql`COALESCE(t."paidAt", t."createdAt")`;
const localOf = (col: Prisma.Sql, tz: string) => Prisma.sql`((${col}) AT TIME ZONE 'UTC' AT TIME ZONE ${tz})`;
const saleScope = (orgId: string, shopIds: string[], p: { from: Date; to: Date }) => Prisma.sql`
  t."organizationId" = ${orgId} AND t."shopId" = ANY(${shopIds}) AND t."status"::text = ANY(${SALE_STATUSES})
  AND ${saleAt} >= ${ts(p.from)} AND ${saleAt} < ${ts(p.to)}`;

/**
 * Line items with ticket-level discounts/points allocated proportionally so that
 * per-kind / per-staff / per-menu sums reconcile with ticket totals.
 * `net_amount` additionally removes the ticket's refunded share.
 */
const allocatedItems = (orgId: string, shopIds: string[], p: { from: Date; to: Date }) => Prisma.sql`
  WITH tk AS (
    SELECT t."id", t."total", t."refundedTotal", t."customerId", t."shopId", ${saleAt} AS at
    FROM "Transaction" t WHERE ${saleScope(orgId, shopIds, p)}
  ), li AS (
    SELECT i.*, GREATEST(0, i."unitPrice" * i."quantity" - i."discount")::float8 AS gross_line
    FROM "TransactionItem" i JOIN tk ON tk."id" = i."transactionId"
  ), sums AS (SELECT "transactionId", SUM(gross_line) AS s FROM li GROUP BY 1),
  ai AS (
    SELECT li."id", li."transactionId", li."kind", li."menuId", li."productId", li."name", li."quantity", li."staffId", li."nominated",
      tk."customerId", tk."shopId", tk.at,
      CASE WHEN sums.s > 0 THEN li.gross_line * tk."total" / sums.s ELSE 0 END AS amount,
      CASE WHEN sums.s > 0 THEN li.gross_line * (tk."total" - tk."refundedTotal") / sums.s ELSE 0 END AS net_amount
    FROM li JOIN tk ON tk."id" = li."transactionId" JOIN sums ON sums."transactionId" = li."transactionId"
  )`;

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

// ───────────────────────── Sales ─────────────────────────

export interface SalesTotals {
  txCount: number; gross: number; discounts: number; pointsUsed: number; sales: number; refunds: number; net: number; tax: number;
  customers: number; walkIns: number; avgTicket: number; service: number; retail: number; other: number;
  newCustomers: number; repeatCustomers: number;
}

export async function salesTotals(orgId: string, shopIds: string[], p: Period): Promise<SalesTotals> {
  if (!shopIds.length) return emptyTotals();
  const [base] = await prisma.$queryRaw<any[]>`
    SELECT COUNT(*)::int AS tx, COALESCE(SUM(t."subtotal"),0)::float8 AS gross, COALESCE(SUM(t."discountTotal"),0)::float8 AS discounts,
      COALESCE(SUM(t."pointsUsed"),0)::float8 AS points, COALESCE(SUM(t."total"),0)::float8 AS sales, COALESCE(SUM(t."taxTotal"),0)::float8 AS tax,
      COUNT(DISTINCT t."customerId")::int AS customers, COUNT(*) FILTER (WHERE t."customerId" IS NULL)::int AS walkins
    FROM "Transaction" t WHERE ${saleScope(orgId, shopIds, p)}`;
  const [ref] = await prisma.$queryRaw<any[]>`
    SELECT COALESCE(SUM(r."amount"),0)::float8 AS refunds
    FROM "Refund" r JOIN "Transaction" t ON t."id" = r."transactionId"
    WHERE t."organizationId" = ${orgId} AND t."shopId" = ANY(${shopIds}) AND r."createdAt" >= ${ts(p.from)} AND r."createdAt" < ${ts(p.to)}`;
  const kinds = await prisma.$queryRaw<any[]>`
    ${allocatedItems(orgId, shopIds, p)}
    SELECT "kind", COALESCE(SUM(amount),0)::float8 AS amount FROM ai GROUP BY 1`;
  const [nr] = await prisma.$queryRaw<any[]>`
    WITH inper AS (
      SELECT DISTINCT t."customerId" FROM "Transaction" t WHERE ${saleScope(orgId, shopIds, p)} AND t."customerId" IS NOT NULL
    ), firsts AS (
      SELECT t."customerId", MIN(${saleAt}) AS f FROM "Transaction" t
      WHERE t."organizationId" = ${orgId} AND t."status"::text = ANY(${VISIT_STATUSES}) AND t."customerId" IN (SELECT "customerId" FROM inper)
      GROUP BY 1
    )
    SELECT COUNT(*) FILTER (WHERE f.f >= ${ts(p.from)})::int AS new_c, COUNT(*) FILTER (WHERE f.f < ${ts(p.from)})::int AS repeat_c
    FROM inper LEFT JOIN firsts f ON f."customerId" = inper."customerId"`;
  const byKind = Object.fromEntries(kinds.map((k) => [k.kind, n(k.amount)]));
  const sales = n(base.sales), refunds = n(ref.refunds), tx = n(base.tx);
  const service = Math.round(byKind.SERVICE ?? 0), retail = Math.round(byKind.RETAIL ?? 0);
  return {
    txCount: tx, gross: n(base.gross), discounts: n(base.discounts), pointsUsed: n(base.points), sales, refunds, net: sales - refunds, tax: n(base.tax),
    customers: n(base.customers), walkIns: n(base.walkins), avgTicket: tx ? Math.round(sales / tx) : 0,
    service, retail, other: Math.max(0, Math.round(sales - service - retail)),
    newCustomers: n(nr?.new_c), repeatCustomers: n(nr?.repeat_c),
  };
}

function emptyTotals(): SalesTotals {
  return { txCount: 0, gross: 0, discounts: 0, pointsUsed: 0, sales: 0, refunds: 0, net: 0, tax: 0, customers: 0, walkIns: 0, avgTicket: 0, service: 0, retail: 0, other: 0, newCustomers: 0, repeatCustomers: 0 };
}

export interface SeriesPoint { bucket: string; shopId: string; sales: number; refunds: number; net: number; tx: number }

/** Daily or monthly sales buckets (shop-local), optionally split per shop. Missing buckets are zero-filled. */
export async function salesSeries(orgId: string, shopIds: string[], p: Period, gran: 'day' | 'month', perShop = false): Promise<{ buckets: string[]; points: SeriesPoint[] }> {
  const fmt = gran === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';
  const buckets: string[] = [];
  if (gran === 'day') for (let d = p.fromDate; d <= p.toDate; d = addDays(d, 1)) buckets.push(d);
  else for (let m = monthStart(p.fromDate); m <= p.toDate; m = addMonths(m, 1)) buckets.push(m.slice(0, 7));
  if (!shopIds.length) return { buckets, points: [] };
  const shopCol = perShop ? Prisma.sql`t."shopId"` : Prisma.sql`''`;
  const sales = await prisma.$queryRaw<any[]>`
    SELECT to_char(${localOf(saleAt, p.tz)}, ${fmt}) AS b, ${shopCol} AS s, COALESCE(SUM(t."total"),0)::float8 AS sales, COUNT(*)::int AS tx
    FROM "Transaction" t WHERE ${saleScope(orgId, shopIds, p)} GROUP BY 1, 2`;
  const refunds = await prisma.$queryRaw<any[]>`
    SELECT to_char(${localOf(Prisma.sql`r."createdAt"`, p.tz)}, ${fmt}) AS b, ${shopCol} AS s, COALESCE(SUM(r."amount"),0)::float8 AS refunds
    FROM "Refund" r JOIN "Transaction" t ON t."id" = r."transactionId"
    WHERE t."organizationId" = ${orgId} AND t."shopId" = ANY(${shopIds}) AND r."createdAt" >= ${ts(p.from)} AND r."createdAt" < ${ts(p.to)}
    GROUP BY 1, 2`;
  const keys = perShop ? shopIds : [''];
  const map = new Map<string, SeriesPoint>();
  for (const b of buckets) for (const s of keys) map.set(`${b}|${s}`, { bucket: b, shopId: s, sales: 0, refunds: 0, net: 0, tx: 0 });
  for (const r of sales) { const pt = map.get(`${r.b}|${r.s}`); if (pt) { pt.sales = n(r.sales); pt.tx = n(r.tx); } }
  for (const r of refunds) { const pt = map.get(`${r.b}|${r.s}`); if (pt) pt.refunds = n(r.refunds); }
  for (const pt of map.values()) pt.net = pt.sales - pt.refunds;
  return { buckets, points: [...map.values()] };
}

export interface ShopRow { shopId: string; sales: number; refunds: number; net: number; tx: number; customers: number; avgTicket: number }

export async function salesByShop(orgId: string, shopIds: string[], p: Period): Promise<ShopRow[]> {
  if (!shopIds.length) return [];
  const rows = await prisma.$queryRaw<any[]>`
    SELECT t."shopId" AS s, COALESCE(SUM(t."total"),0)::float8 AS sales, COUNT(*)::int AS tx, COUNT(DISTINCT t."customerId")::int AS customers
    FROM "Transaction" t WHERE ${saleScope(orgId, shopIds, p)} GROUP BY 1`;
  const refunds = await prisma.$queryRaw<any[]>`
    SELECT t."shopId" AS s, COALESCE(SUM(r."amount"),0)::float8 AS refunds
    FROM "Refund" r JOIN "Transaction" t ON t."id" = r."transactionId"
    WHERE t."organizationId" = ${orgId} AND t."shopId" = ANY(${shopIds}) AND r."createdAt" >= ${ts(p.from)} AND r."createdAt" < ${ts(p.to)} GROUP BY 1`;
  return shopIds.map((shopId) => {
    const r = rows.find((x) => x.s === shopId);
    const rf = n(refunds.find((x) => x.s === shopId)?.refunds);
    const sales = n(r?.sales), tx = n(r?.tx);
    return { shopId, sales, refunds: rf, net: sales - rf, tx, customers: n(r?.customers), avgTicket: tx ? Math.round(sales / tx) : 0 };
  });
}

export async function paymentBreakdown(orgId: string, shopIds: string[], p: Period): Promise<{ method: string; amount: number; count: number }[]> {
  if (!shopIds.length) return [];
  const rows = await prisma.$queryRaw<any[]>`
    SELECT pm."method"::text AS method, COALESCE(SUM(pm."amount"),0)::float8 AS amount, COUNT(*)::int AS c
    FROM "Payment" pm JOIN "Transaction" t ON t."id" = pm."transactionId"
    WHERE ${saleScope(orgId, shopIds, p)} AND pm."status" = 'SUCCEEDED'
    GROUP BY 1 ORDER BY 2 DESC`;
  return rows.map((r) => ({ method: r.method, amount: n(r.amount), count: n(r.c) }));
}

export interface NominationSplit { nominatedSales: number; freeSales: number; nominatedTickets: number; freeTickets: number; nominatedAppts: number; freeAppts: number }

export async function nominationSplit(orgId: string, shopIds: string[], p: Period): Promise<NominationSplit> {
  if (!shopIds.length) return { nominatedSales: 0, freeSales: 0, nominatedTickets: 0, freeTickets: 0, nominatedAppts: 0, freeAppts: 0 };
  const [s] = await prisma.$queryRaw<any[]>`
    ${allocatedItems(orgId, shopIds, p)}, tn AS (
      SELECT "transactionId", BOOL_OR("nominated") AS nom FROM ai WHERE "kind" = 'SERVICE' GROUP BY 1
    )
    SELECT
      (SELECT COALESCE(SUM(amount),0) FROM ai WHERE "kind" = 'SERVICE' AND "nominated")::float8 AS nom_sales,
      (SELECT COALESCE(SUM(amount),0) FROM ai WHERE "kind" = 'SERVICE' AND NOT "nominated")::float8 AS free_sales,
      (SELECT COUNT(*) FROM tn WHERE nom)::int AS nom_tx,
      (SELECT COUNT(*) FROM tn WHERE NOT nom)::int AS free_tx`;
  const appts = await prisma.appointment.groupBy({
    by: ['nominated'], _count: true,
    where: { organizationId: orgId, shopId: { in: shopIds }, status: 'COMPLETED', kind: { not: 'PRIVATE' }, startAt: { gte: p.from, lt: p.to } },
  });
  return {
    nominatedSales: Math.round(n(s.nom_sales)), freeSales: Math.round(n(s.free_sales)), nominatedTickets: n(s.nom_tx), freeTickets: n(s.free_tx),
    nominatedAppts: appts.find((a) => a.nominated)?._count ?? 0, freeAppts: appts.find((a) => !a.nominated)?._count ?? 0,
  };
}

export interface SourceRow { source: string; appointments: number; completed: number; cancelled: number; noShow: number; revenue: number }

export async function sourcePerformance(orgId: string, shopIds: string[], p: Period): Promise<SourceRow[]> {
  if (!shopIds.length) return [];
  const rows = await prisma.$queryRaw<any[]>`
    SELECT a."source"::text AS source, COUNT(*)::int AS appts,
      COUNT(*) FILTER (WHERE a."status" = 'COMPLETED')::int AS completed,
      COUNT(*) FILTER (WHERE a."status" = 'CANCELLED')::int AS cancelled,
      COUNT(*) FILTER (WHERE a."status" = 'NO_SHOW')::int AS no_show,
      COALESCE(SUM(CASE WHEN t."status"::text = ANY(${SALE_STATUSES}) THEN t."total" - t."refundedTotal" ELSE 0 END),0)::float8 AS revenue
    FROM "Appointment" a LEFT JOIN "Transaction" t ON t."appointmentId" = a."id"
    WHERE a."organizationId" = ${orgId} AND a."shopId" = ANY(${shopIds}) AND a."kind" <> 'PRIVATE'
      AND a."startAt" >= ${ts(p.from)} AND a."startAt" < ${ts(p.to)}
    GROUP BY 1 ORDER BY 6 DESC, 2 DESC`;
  return rows.map((r) => ({ source: r.source, appointments: n(r.appts), completed: n(r.completed), cancelled: n(r.cancelled), noShow: n(r.no_show), revenue: n(r.revenue) }));
}

export interface MenuRankRow { key: string; name: string; kind: string; count: number; revenue: number }

export async function menuRanking(orgId: string, shopIds: string[], p: Period, kind: 'SERVICE' | 'RETAIL' = 'SERVICE', limit = 30): Promise<MenuRankRow[]> {
  if (!shopIds.length) return [];
  const rows = await prisma.$queryRaw<any[]>`
    ${allocatedItems(orgId, shopIds, p)}
    SELECT COALESCE("menuId", "productId", 'name:' || "name") AS k, MAX("name") AS name, "kind",
      COALESCE(SUM("quantity"),0)::int AS c, COALESCE(SUM(amount),0)::float8 AS revenue
    FROM ai WHERE "kind" = ${kind} GROUP BY 1, 3 ORDER BY 5 DESC LIMIT ${limit}`;
  return rows.map((r) => ({ key: r.k, name: r.name, kind: r.kind, count: n(r.c), revenue: Math.round(n(r.revenue)) }));
}

// ───────────────────────── Staff KPI ─────────────────────────

export interface StaffKpiRow {
  userId: string; name: string; role: string | null; active: boolean;
  service: number; retail: number; total: number; tickets: number; customers: number;
  nominatedTickets: number; nominationRate: number; served: number; returned: number; repeatRate: number;
  avgTicket: number; assignedCustomers: number; avgAssignedLtv: number;
}

export async function staffKpi(orgId: string, shopIds: string[], p: Period, repeatWithinDays = 90): Promise<StaffKpiRow[]> {
  if (!shopIds.length) return [];
  const sales = await prisma.$queryRaw<any[]>`
    ${allocatedItems(orgId, shopIds, p)}
    SELECT "staffId" AS u,
      COALESCE(SUM(net_amount) FILTER (WHERE "kind" = 'SERVICE'),0)::float8 AS service,
      COALESCE(SUM(net_amount) FILTER (WHERE "kind" = 'RETAIL'),0)::float8 AS retail,
      COALESCE(SUM(net_amount),0)::float8 AS total,
      COUNT(DISTINCT "transactionId")::int AS tickets,
      COUNT(DISTINCT "customerId")::int AS customers,
      COUNT(DISTINCT "transactionId") FILTER (WHERE "kind" = 'SERVICE' AND "nominated")::int AS nom_tickets,
      COUNT(DISTINCT "transactionId") FILTER (WHERE "kind" = 'SERVICE')::int AS svc_tickets
    FROM ai WHERE "staffId" IS NOT NULL GROUP BY 1`;
  const rep = await prisma.$queryRaw<any[]>`
    ${allocatedItems(orgId, shopIds, p)}, served AS (
      SELECT "staffId", "customerId", MIN(at) AS first_at FROM ai
      WHERE "staffId" IS NOT NULL AND "customerId" IS NOT NULL AND "kind" = 'SERVICE' GROUP BY 1, 2
    )
    SELECT s."staffId" AS u, COUNT(*)::int AS served,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM "Transaction" t2 WHERE t2."organizationId" = ${orgId} AND t2."customerId" = s."customerId"
          AND t2."status"::text = ANY(${VISIT_STATUSES})
          AND COALESCE(t2."paidAt", t2."createdAt") > s.first_at + interval '1 hour'
          AND COALESCE(t2."paidAt", t2."createdAt") <= s.first_at + (${repeatWithinDays}::int * interval '1 day')
      ))::int AS returned
    FROM served s GROUP BY 1`;
  const ltv = await prisma.customer.groupBy({
    by: ['assignedStaffId'], where: { organizationId: orgId, mergedIntoId: null, deletedAt: null, assignedStaffId: { not: null }, visitCount: { gt: 0 } },
    _avg: { totalSales: true }, _count: true,
  });
  const members = await prisma.membership.findMany({
    where: { organizationId: orgId, OR: [{ shops: { some: { shopId: { in: shopIds } } } }, { userId: { in: sales.map((s) => s.u) } }] },
    select: { userId: true, displayName: true, role: true, active: true, sortOrder: true, bookable: true },
    orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
  });
  const ids = new Set<string>([...members.filter((m) => m.bookable || sales.some((s) => s.u === m.userId)).map((m) => m.userId), ...sales.map((s) => s.u as string)]);
  const rows: StaffKpiRow[] = [];
  for (const userId of ids) {
    const m = members.find((x) => x.userId === userId);
    const s = sales.find((x) => x.u === userId);
    const r = rep.find((x) => x.u === userId);
    const l = ltv.find((x) => x.assignedStaffId === userId);
    const tickets = n(s?.tickets), total = Math.round(n(s?.total));
    rows.push({
      userId, name: m?.displayName ?? '（削除済みスタッフ）', role: m?.role ?? null, active: m?.active ?? false,
      service: Math.round(n(s?.service)), retail: Math.round(n(s?.retail)), total, tickets, customers: n(s?.customers),
      nominatedTickets: n(s?.nom_tickets), nominationRate: n(s?.svc_tickets) ? n(s?.nom_tickets) / n(s?.svc_tickets) : 0,
      served: n(r?.served), returned: n(r?.returned), repeatRate: n(r?.served) ? n(r?.returned) / n(r?.served) : 0,
      avgTicket: tickets ? Math.round(total / tickets) : 0,
      assignedCustomers: l?._count ?? 0, avgAssignedLtv: Math.round(l?._avg.totalSales ?? 0),
    });
  }
  return rows.sort((a, b) => b.total - a.total);
}

// ───────────────────────── Customers / LTV ─────────────────────────

export interface CustomerStatRow {
  id: string; name: string; visitCount: number; ltv: number; avgSpend: number; firstVisitAt: Date | null; lastVisitAt: Date | null;
  avgIntervalDays: number | null; daysSince: number | null; lifecycle: Lifecycle; assignedStaffId: string | null; primaryShopId: string | null; tagIds: string[];
}

/** Live customers with lifecycle stats. shopId → customers whose primary shop is that shop. */
export async function customerStats(orgId: string, shopId: string | null, now = new Date()): Promise<CustomerStatRow[]> {
  const rows = await prisma.customer.findMany({
    where: { organizationId: orgId, mergedIntoId: null, deletedAt: null, ...(shopId ? { primaryShopId: shopId } : {}) },
    select: { id: true, lastName: true, firstName: true, visitCount: true, totalSales: true, firstVisitAt: true, lastVisitAt: true, assignedStaffId: true, primaryShopId: true, tags: { select: { tagId: true } } },
  });
  const t = now.getTime();
  return rows.map((c) => {
    const avgIntervalDays = c.visitCount >= 2 && c.firstVisitAt && c.lastVisitAt
      ? Math.round(((c.lastVisitAt.getTime() - c.firstVisitAt.getTime()) / 86400000 / (c.visitCount - 1)) * 10) / 10 : null;
    return {
      id: c.id, name: `${c.lastName} ${c.firstName}`.trim(), visitCount: c.visitCount, ltv: c.totalSales,
      avgSpend: c.visitCount ? Math.round(c.totalSales / c.visitCount) : 0, firstVisitAt: c.firstVisitAt, lastVisitAt: c.lastVisitAt,
      avgIntervalDays, daysSince: c.lastVisitAt ? Math.floor((t - c.lastVisitAt.getTime()) / 86400000) : null,
      lifecycle: lifecycle({ visitCount: c.visitCount, lastVisitAt: c.lastVisitAt?.getTime() ?? null, avgIntervalDays }, t),
      assignedStaffId: c.assignedStaffId, primaryShopId: c.primaryShopId, tagIds: c.tags.map((x) => x.tagId),
    };
  });
}

export const LTV_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: '〜1万円', min: 1, max: 10_000 },
  { label: '1〜3万円', min: 10_000, max: 30_000 },
  { label: '3〜5万円', min: 30_000, max: 50_000 },
  { label: '5〜10万円', min: 50_000, max: 100_000 },
  { label: '10〜20万円', min: 100_000, max: 200_000 },
  { label: '20万円〜', min: 200_000, max: Infinity },
];
export const INTERVAL_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: '〜30日', min: 0, max: 30 }, { label: '31〜45日', min: 30, max: 45 }, { label: '46〜60日', min: 45, max: 60 },
  { label: '61〜90日', min: 60, max: 90 }, { label: '91〜180日', min: 90, max: 180 }, { label: '181日〜', min: 180, max: Infinity },
];

export function ltvDistribution(rows: CustomerStatRow[]) {
  const visited = rows.filter((r) => r.visitCount > 0);
  return LTV_BUCKETS.map((b) => {
    const inB = visited.filter((r) => r.ltv >= b.min && r.ltv < b.max);
    return { label: b.label, count: inB.length, ltv: inB.reduce((s, r) => s + r.ltv, 0) };
  });
}

export function intervalDistribution(rows: CustomerStatRow[]) {
  const withI = rows.filter((r) => r.avgIntervalDays !== null);
  return INTERVAL_BUCKETS.map((b) => ({ label: b.label, count: withI.filter((r) => r.avgIntervalDays! > b.min - (b.min === 0 ? 1 : 0) && r.avgIntervalDays! <= b.max).length }));
}

export function lifecycleCounts(rows: CustomerStatRow[]): Record<Lifecycle, number> {
  const out: Record<Lifecycle, number> = { NEW: 0, ACTIVE: 0, DUE: 0, OVERDUE: 0, DORMANT: 0, PROSPECT: 0 };
  for (const r of rows) out[r.lifecycle]++;
  return out;
}

export async function ltvByTag(orgId: string, rows: CustomerStatRow[]) {
  const tags = await prisma.tag.findMany({ where: { organizationId: orgId }, orderBy: { name: 'asc' } });
  const visited = rows.filter((r) => r.visitCount > 0);
  const seg = (list: CustomerStatRow[]) => ({
    customers: list.length, totalLtv: list.reduce((s, r) => s + r.ltv, 0),
    avgLtv: list.length ? Math.round(list.reduce((s, r) => s + r.ltv, 0) / list.length) : 0,
    avgVisits: list.length ? Math.round((list.reduce((s, r) => s + r.visitCount, 0) / list.length) * 10) / 10 : 0,
  });
  const out = tags.map((t) => ({ key: t.id, label: t.name, color: t.color, ...seg(visited.filter((r) => r.tagIds.includes(t.id))) }));
  out.push({ key: '_untagged', label: 'タグなし', color: '#9aa3b8', ...seg(visited.filter((r) => r.tagIds.length === 0)) });
  return out;
}

/** Repeat rate by first-visit month: share of new customers who came back within `withinDays`. */
export async function cohortRepeat(orgId: string, shopIds: string[] | null, tz: string, months = 12, withinDays = 90, now = new Date()) {
  const today = todayIn(tz, now);
  const start = addMonths(monthStart(today), -(months - 1));
  const shopFilter = shopIds ? Prisma.sql`AND t."shopId" = ANY(${shopIds})` : Prisma.empty;
  const rows = await prisma.$queryRaw<{ customerId: string; first: Date; second: Date | null }[]>`
    WITH v AS (
      SELECT t."customerId", COALESCE(t."paidAt", t."createdAt") AS at FROM "Transaction" t
      WHERE t."organizationId" = ${orgId} AND t."status"::text = ANY(${VISIT_STATUSES}) AND t."customerId" IS NOT NULL ${shopFilter}
    ), r AS (
      SELECT "customerId", at, ROW_NUMBER() OVER (PARTITION BY "customerId" ORDER BY at) AS rn FROM v
    )
    SELECT "customerId", MAX(at) FILTER (WHERE rn = 1) AS first, MAX(at) FILTER (WHERE rn = 2) AS second
    FROM r WHERE rn <= 2 GROUP BY 1
    HAVING MAX(at) FILTER (WHERE rn = 1) >= ${ts(localToUtc(start, 0, tz))}`;
  const byMonth = new Map<string, { first: number; second: number | null }[]>();
  for (let m = start; m <= today; m = addMonths(m, 1)) byMonth.set(m.slice(0, 7), []);
  for (const r of rows) {
    // raw timestamps come back as naive UTC Dates
    const key = toLocalParts(new Date(r.first), tz).date.slice(0, 7);
    byMonth.get(key)?.push({ first: new Date(r.first).getTime(), second: r.second ? new Date(r.second).getTime() : null });
  }
  const nowMs = now.getTime();
  return [...byMonth.entries()].map(([month, list]) => {
    // a cohort is "mature" once every member had the full window to return
    const monthEnd = localToUtc(addMonths(month + '-01', 1), 0, tz).getTime();
    return { month, newCustomers: list.length, returned: list.filter((c) => c.second !== null && c.second - c.first <= withinDays * 86400000).length, rate: repeatRate(list, withinDays), mature: monthEnd + withinDays * 86400000 <= nowMs };
  });
}

// ───────────────────────── Dashboard ─────────────────────────

/** Share of customers whose first visit was 90–180 days ago that returned within 90 days. */
export async function recentRepeatRate(orgId: string, shopIds: string[], now = new Date(), withinDays = 90) {
  const from = new Date(now.getTime() - 2 * withinDays * 86400000), to = new Date(now.getTime() - withinDays * 86400000);
  const rows = await prisma.$queryRaw<{ first: Date; second: Date | null }[]>`
    WITH v AS (
      SELECT t."customerId", COALESCE(t."paidAt", t."createdAt") AS at FROM "Transaction" t
      WHERE t."organizationId" = ${orgId} AND t."status"::text = ANY(${VISIT_STATUSES}) AND t."customerId" IS NOT NULL
    ), r AS (SELECT "customerId", at, ROW_NUMBER() OVER (PARTITION BY "customerId" ORDER BY at) AS rn FROM v),
    f AS (
      SELECT "customerId", MAX(at) FILTER (WHERE rn = 1) AS first, MAX(at) FILTER (WHERE rn = 2) AS second FROM r WHERE rn <= 2 GROUP BY 1
    )
    SELECT f.first, f.second FROM f
    WHERE f.first >= ${ts(from)} AND f.first < ${ts(to)}
      AND EXISTS (SELECT 1 FROM "Transaction" t WHERE t."customerId" = f."customerId" AND t."shopId" = ANY(${shopIds}) AND COALESCE(t."paidAt", t."createdAt") = f.first)`;
  const list = rows.map((r) => ({ first: new Date(r.first).getTime(), second: r.second ? new Date(r.second).getTime() : null }));
  return { cohort: list.length, rate: repeatRate(list, withinDays) };
}

export async function dayTotals(orgId: string, shopIds: string[], date: string, tz: string) {
  return salesTotals(orgId, shopIds, makePeriod(date, date, tz, 'custom'));
}
