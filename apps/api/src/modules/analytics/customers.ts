import { sql } from 'kysely';
import type { Ctx } from '../../auth/actor.js';
import { dayBounds, localDate } from '../../lib/time.js';
import { displayName } from '../customers/service.js';
import { visibleCustomerFilter } from '../customers/access.js';
import type { CustomersQuery, LtvQuery, RepeatRateQuery } from './schemas.js';
import {
  addDaysIso,
  auditSalesView,
  bucketKey,
  bucketKeys,
  compareRange,
  daysBetween,
  deltas,
  pct,
  ratio,
  resolveRange,
  resolveScope,
  round1,
  type DateRange,
  type Scope,
} from './scope.js';

/**
 * Customer-level metrics need per-customer visit history, which daily aggregates cannot answer,
 * so they are computed live — but only over "counted visits" (completed / partially_refunded
 * transactions with a customer) via the partial index transactions_counted_customer_idx.
 *
 * Visit (来店) = transaction with status completed|partially_refunded, customer_id set.
 * New visit   = transactions.is_new_customer, or (when NULL) the customer's first visit org-wide.
 */

const DAY_MS = 86_400_000;

function bounds(range: DateRange, tz: string) {
  return { start: dayBounds(range.from, tz).start, end: dayBounds(range.to, tz).end };
}

interface PeriodCustomerMetrics {
  visitors: number;
  newCustomers: number;
  repeatCustomers: number;
  lostCustomers: number;
  repeatRate: number | null;
}

async function periodMetrics(ctx: Ctx, scope: Scope, range: DateRange, lostDays: number): Promise<PeriodCustomerMetrics & { visitorIds: string[] }> {
  const org = ctx.actor.organizationId;
  const { start, end } = bounds(range, scope.tz);
  const lostWindow = bounds({ from: addDaysIso(range.from, -lostDays), to: addDaysIso(range.to, -lostDays) }, scope.tz);

  const visitorsRes = await sql<{ customer_id: string; is_new: boolean }>`
    WITH v AS (
      SELECT t.id, t.customer_id, t.shop_id, t.completed_at, t.is_new_customer,
             row_number() OVER (PARTITION BY t.customer_id ORDER BY t.completed_at, t.id) AS seq
        FROM transactions t
       WHERE t.organization_id = ${org}
         AND t.status IN ('completed', 'partially_refunded') AND t.customer_id IS NOT NULL
         AND t.completed_at < ${end}
         AND t.customer_id IN (
           SELECT customer_id FROM transactions
            WHERE organization_id = ${org} AND status IN ('completed', 'partially_refunded') AND customer_id IS NOT NULL
              AND shop_id = ANY(${scope.shopIds}::uuid[]) AND completed_at >= ${start} AND completed_at < ${end})
    )
    SELECT customer_id, bool_or(coalesce(is_new_customer, seq = 1)) AS is_new
      FROM v
     WHERE shop_id = ANY(${scope.shopIds}::uuid[]) AND completed_at >= ${start} AND completed_at < ${end}
     GROUP BY customer_id`.execute(ctx.trx);

  // 失客: last visit (org-wide, as of `to`) fell exactly lostDays before a day of the period,
  // i.e. the customer crossed the threshold during the period; attributed to the shop of that last visit.
  const lostRes = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM (
      SELECT DISTINCT ON (customer_id) customer_id, shop_id, completed_at
        FROM transactions
       WHERE organization_id = ${org} AND status IN ('completed', 'partially_refunded') AND customer_id IS NOT NULL
         AND completed_at < ${end}
       ORDER BY customer_id, completed_at DESC, id DESC
    ) last
     WHERE last.shop_id = ANY(${scope.shopIds}::uuid[])
       AND last.completed_at >= ${lostWindow.start} AND last.completed_at < ${lostWindow.end}`.execute(ctx.trx);

  const visitors = visitorsRes.rows.length;
  const newCustomers = visitorsRes.rows.filter((r) => r.is_new).length;
  return {
    visitors,
    newCustomers,
    repeatCustomers: visitors - newCustomers,
    lostCustomers: lostRes.rows[0]?.n ?? 0,
    repeatRate: pct(visitors - newCustomers, visitors),
    visitorIds: visitorsRes.rows.map((r) => r.customer_id),
  };
}

export const CYCLE_BUCKETS = [
  { key: 'le30', label: '〜30日', max: 30 },
  { key: '31_45', label: '31〜45日', max: 45 },
  { key: '46_60', label: '46〜60日', max: 60 },
  { key: '61_90', label: '61〜90日', max: 90 },
  { key: '91_120', label: '91〜120日', max: 120 },
  { key: 'gt120', label: '121日〜', max: Infinity },
] as const;

/** 来店周期 = (最終来店 − 初回来店) ÷ (来店回数 − 1), visits up to the end of the period */
async function cycleDistribution(ctx: Ctx, scope: Scope, range: DateRange, customerIds: string[]) {
  const { end } = bounds(range, scope.tz);
  const rows = customerIds.length
    ? (
        await sql<{ customer_id: string; n: number; first_at: Date; last_at: Date }>`
          SELECT customer_id, count(*)::int AS n, min(completed_at) AS first_at, max(completed_at) AS last_at
            FROM transactions
           WHERE organization_id = ${ctx.actor.organizationId} AND status IN ('completed', 'partially_refunded')
             AND customer_id = ANY(${customerIds}::uuid[]) AND completed_at < ${end}
           GROUP BY customer_id`.execute(ctx.trx)
      ).rows
    : [];
  const cycles: number[] = [];
  let singleVisit = 0;
  for (const r of rows) {
    if (r.n < 2) singleVisit++;
    else cycles.push((r.last_at.getTime() - r.first_at.getTime()) / DAY_MS / (r.n - 1));
  }
  cycles.sort((a, b) => a - b);
  const buckets = CYCLE_BUCKETS.map((b, i) => {
    const min = i === 0 ? -Infinity : CYCLE_BUCKETS[i - 1]!.max;
    const count = cycles.filter((c) => c > min && c <= b.max).length;
    return { key: b.key, label: b.label, count, share: pct(count, cycles.length) };
  });
  const median = cycles.length ? (cycles.length % 2 ? cycles[(cycles.length - 1) / 2]! : (cycles[cycles.length / 2 - 1]! + cycles[cycles.length / 2]!) / 2) : null;
  return {
    customers: rows.length,
    multiVisitCustomers: cycles.length,
    singleVisitCustomers: singleVisit,
    avgCycleDays: cycles.length ? round1(cycles.reduce((a, b) => a + b, 0) / cycles.length) : null,
    medianCycleDays: median === null ? null : round1(median),
    buckets,
  };
}

/** GET /analytics/customers — 新規/再来/失客 + 来店周期分布 */
export async function customersReport(ctx: Ctx, input: CustomersQuery) {
  const scope = await resolveScope(ctx, input.shopId, { full: ['analytics.read'] });
  const range = resolveRange(input, scope.tz);
  const cmp = compareRange(range, input.compareTo);
  const cur = await periodMetrics(ctx, scope, range, input.lostThresholdDays);
  const prev = cmp ? await periodMetrics(ctx, scope, cmp, input.lostThresholdDays) : null;
  const cycle = await cycleDistribution(ctx, scope, range, cur.visitorIds);

  // period buckets from daily aggregates (新規/再来 are distinct per shop-day there)
  const daily = await ctx.trx
    .selectFrom('analytics_daily_shop')
    .select(['date', 'new_customer_count', 'repeat_customer_count', 'customer_count'])
    .where('shop_id', 'in', scope.shopIds)
    .where('date', '>=', range.from)
    .where('date', '<=', range.to)
    .execute();
  const rows = bucketKeys(range, input.groupBy).map((k) => {
    const ds = daily.filter((d) => bucketKey(d.date, input.groupBy) === k);
    const n = ds.reduce((s, d) => s + d.new_customer_count, 0);
    const r = ds.reduce((s, d) => s + d.repeat_customer_count, 0);
    return { period: k, newCustomerVisits: n, repeatCustomerVisits: r, customerVisits: ds.reduce((s, d) => s + d.customer_count, 0) };
  });

  const strip = ({ visitorIds: _v, ...m }: PeriodCustomerMetrics & { visitorIds: string[] }) => m;
  await auditSalesView(ctx, 'customers', scope, { range });
  return {
    range: { ...range, days: daysBetween(range.from, range.to) + 1 },
    shopIds: scope.shops.map((s) => s.id),
    compareTo: input.compareTo,
    lostThresholdDays: input.lostThresholdDays,
    lostWindow: { from: addDaysIso(range.from, -input.lostThresholdDays), to: addDaysIso(range.to, -input.lostThresholdDays) },
    summary: strip(cur),
    comparison: prev && cmp ? { range: cmp, summary: strip(prev), deltas: deltas(numericOf(strip(cur)), numericOf(strip(prev))) } : null,
    visitCycle: cycle,
    rows,
  };
}

function numericOf(o: object): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(o)) if (typeof v === 'number' || v === null) out[k] = v as number | null;
  return out;
}

// ---------------------------------------------------------------- repeat rate

export const REPEAT_WINDOWS = [30, 60, 90] as const;

/**
 * GET /analytics/repeat-rate — 新規リピート率.
 * Cohort = customers whose new visit is within the period at a scope shop.
 * returnedN = another visit (any shop) within N days after that first visit.
 * rateN = returnedN ÷ eligibleN, where eligible = first visit + N days ≤ now (window fully elapsed).
 */
export async function repeatRateReport(ctx: Ctx, input: RepeatRateQuery) {
  const scope = await resolveScope(ctx, input.shopId, { full: ['analytics.read'] });
  const range = resolveRange(input, scope.tz);
  const cmp = compareRange(range, input.compareTo);

  const cohortOf = async (r: DateRange) => {
    const { start, end } = bounds(r, scope.tz);
    const org = ctx.actor.organizationId;
    const res = await sql<{ customer_id: string; first_at: Date; next_at: Date | null }>`
      WITH v AS (
        SELECT t.id, t.customer_id, t.shop_id, t.completed_at, t.is_new_customer,
               row_number() OVER (PARTITION BY t.customer_id ORDER BY t.completed_at, t.id) AS seq
          FROM transactions t
         WHERE t.organization_id = ${org} AND t.status IN ('completed', 'partially_refunded') AND t.customer_id IS NOT NULL
           AND t.customer_id IN (
             SELECT customer_id FROM transactions
              WHERE organization_id = ${org} AND status IN ('completed', 'partially_refunded') AND customer_id IS NOT NULL
                AND shop_id = ANY(${scope.shopIds}::uuid[]) AND completed_at >= ${start} AND completed_at < ${end})
      ),
      firsts AS (
        SELECT DISTINCT ON (customer_id) customer_id, completed_at AS first_at, id AS first_id
          FROM v
         WHERE coalesce(is_new_customer, seq = 1) AND shop_id = ANY(${scope.shopIds}::uuid[])
           AND completed_at >= ${start} AND completed_at < ${end}
         ORDER BY customer_id, completed_at, id
      )
      SELECT f.customer_id, f.first_at,
             (SELECT min(v2.completed_at) FROM v v2
               WHERE v2.customer_id = f.customer_id AND v2.id <> f.first_id
                 AND (v2.completed_at, v2.id) > (f.first_at, f.first_id)) AS next_at
        FROM firsts f`.execute(ctx.trx);
    return res.rows;
  };

  const now = Date.now();
  const rates = (rows: { first_at: Date; next_at: Date | null }[]) => {
    const out: Record<string, { eligible: number; returned: number; rate: number | null }> = {};
    for (const n of REPEAT_WINDOWS) {
      const eligible = rows.filter((r) => r.first_at.getTime() + n * DAY_MS <= now);
      const returned = eligible.filter((r) => r.next_at && r.next_at.getTime() - r.first_at.getTime() <= n * DAY_MS).length;
      out[`d${n}`] = { eligible: eligible.length, returned, rate: pct(returned, eligible.length) };
    }
    const returnedEver = rows.filter((r) => r.next_at).length;
    return { cohortSize: rows.length, windows: out, returnedEver, returnedEverRate: pct(returnedEver, rows.length) };
  };

  const cohort = await cohortOf(range);
  const prevCohort = cmp ? await cohortOf(cmp) : null;
  const overall = await periodMetrics(ctx, scope, range, 90);
  const cohorts = bucketKeys(range, input.groupBy).map((k) => ({
    cohort: k,
    ...rates(cohort.filter((r) => bucketKey(localDate(r.first_at, scope.tz), input.groupBy) === k)),
  }));
  const summary = rates(cohort);
  await auditSalesView(ctx, 'repeat-rate', scope, { range });
  return {
    range: { ...range, days: daysBetween(range.from, range.to) + 1 },
    shopIds: scope.shops.map((s) => s.id),
    compareTo: input.compareTo,
    windows: [...REPEAT_WINDOWS],
    summary,
    overallRepeatRate: { visitors: overall.visitors, repeatCustomers: overall.repeatCustomers, rate: overall.repeatRate },
    comparison: prevCohort && cmp ? { range: cmp, summary: rates(prevCohort) } : null,
    cohorts,
  };
}

// ---------------------------------------------------------------- LTV

/**
 * GET /analytics/ltv — LTV = 顧客あたり累計純売上 (all shops of the org; customers acquired at scope shops).
 *  - ltvAllTime: Σ net sales to date ÷ customers
 *  - ltv12m:     Σ net sales within 365 days of the first visit ÷ customers whose first visit is ≥ 365 days ago
 * Grouped by acquisition source (customers.acquisition_source), first-visit shop and first-visit month.
 */
export async function ltvReport(ctx: Ctx, input: LtvQuery) {
  const scope = await resolveScope(ctx, input.shopId, { full: ['analytics.read'] });
  const org = ctx.actor.organizationId;
  const from = input.from ?? '1970-01-01';
  const to = input.to ?? localDate(new Date(), scope.tz);
  const { start, end } = bounds({ from, to }, scope.tz);
  const res = await sql<{
    customer_id: string;
    first_at: Date;
    first_shop: string;
    total: number;
    net12: number;
    visits: number;
    last_at: Date;
    acquisition_source: string | null;
  }>`
    WITH v AS (
      SELECT t.id, t.customer_id, t.shop_id, t.completed_at, (t.total - t.refunded_total) AS net,
             row_number() OVER (PARTITION BY t.customer_id ORDER BY t.completed_at, t.id) AS seq
        FROM transactions t
       WHERE t.organization_id = ${org} AND t.status IN ('completed', 'partially_refunded') AND t.customer_id IS NOT NULL
    ),
    f AS (SELECT customer_id, completed_at AS first_at, shop_id AS first_shop FROM v WHERE seq = 1)
    SELECT f.customer_id, f.first_at, f.first_shop,
           sum(v.net)::bigint AS total,
           coalesce(sum(v.net) FILTER (WHERE v.completed_at < f.first_at + interval '365 days'), 0)::bigint AS net12,
           count(*)::int AS visits, max(v.completed_at) AS last_at,
           c.acquisition_source
      FROM f
      JOIN v ON v.customer_id = f.customer_id
      JOIN customers c ON c.id = f.customer_id
     WHERE f.first_shop = ANY(${scope.shopIds}::uuid[]) AND f.first_at >= ${start} AND f.first_at < ${end}
     GROUP BY f.customer_id, f.first_at, f.first_shop, c.acquisition_source`.execute(ctx.trx);
  const rows = res.rows;
  const maturedBefore = Date.now() - 365 * DAY_MS;

  const agg = (list: typeof rows) => {
    const matured = list.filter((r) => r.first_at.getTime() <= maturedBefore);
    const total = list.reduce((s, r) => s + r.total, 0);
    return {
      customers: list.length,
      totalSales: total,
      ltvAllTime: ratio(total, list.length),
      maturedCustomers: matured.length,
      ltv12m: ratio(
        matured.reduce((s, r) => s + r.net12, 0),
        matured.length,
      ),
      avgVisits: list.length ? round1(list.reduce((s, r) => s + r.visits, 0) / list.length) : null,
      avgTicket: ratio(total, list.reduce((s, r) => s + r.visits, 0)),
    };
  };
  const groupBy = (keyOf: (r: (typeof rows)[number]) => string) => {
    const m = new Map<string, typeof rows>();
    for (const r of rows) m.set(keyOf(r), [...(m.get(keyOf(r)) ?? []), r]);
    return m;
  };
  const shopName = new Map(scope.shops.map((s) => [s.id, s.name]));
  const bySource = [...groupBy((r) => r.acquisition_source?.trim() || '不明')]
    .map(([source, list]) => ({ source, ...agg(list) }))
    .sort((a, b) => (b.ltvAllTime ?? 0) - (a.ltvAllTime ?? 0));
  const byShop = [...groupBy((r) => r.first_shop)].map(([shopId, list]) => ({ shopId, shopName: shopName.get(shopId) ?? '', ...agg(list) }));
  const byCohort = [...groupBy((r) => localDate(r.first_at, scope.tz).slice(0, 7))]
    .map(([cohort, list]) => ({ cohort, ...agg(list) }))
    .sort((a, b) => a.cohort.localeCompare(b.cohort));

  // top customers by all-time net sales, restricted to customers the caller may see
  let top: Record<string, unknown>[] = [];
  if (input.top > 0 && rows.length) {
    const candidates = [...rows].sort((a, b) => b.total - a.total || a.customer_id.localeCompare(b.customer_id)).slice(0, input.top * 3);
    let q = ctx.trx
      .selectFrom('customers')
      .select(['customers.id', 'customers.last_name', 'customers.first_name', 'customers.last_name_kana', 'customers.first_name_kana'])
      .where('customers.id', 'in', candidates.map((c) => c.customer_id));
    const filter = visibleCustomerFilter(ctx);
    if (filter) q = q.where(filter);
    const visible = new Map((await q.execute()).map((c) => [c.id, c]));
    top = candidates
      .filter((c) => visible.has(c.customer_id))
      .slice(0, input.top)
      .map((c) => ({
        customerId: c.customer_id,
        customerName: displayName(visible.get(c.customer_id)!),
        totalSales: c.total,
        sales12m: c.net12,
        visits: c.visits,
        firstVisitAt: c.first_at,
        lastVisitAt: c.last_at,
        acquisitionSource: c.acquisition_source,
      }));
  }
  await auditSalesView(ctx, 'ltv', scope, { from: input.from ?? null, to: input.to ?? null });
  return {
    shopIds: scope.shops.map((s) => s.id),
    firstVisitRange: { from: input.from ?? null, to: input.to ?? null },
    asOf: new Date().toISOString(),
    summary: agg(rows),
    bySource,
    byShop,
    byCohort,
    topCustomers: top,
  };
}

