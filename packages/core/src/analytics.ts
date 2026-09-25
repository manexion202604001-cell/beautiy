// Customer lifecycle metrics: LTV, visit interval, repeat, dormancy.

export interface Visit { at: Date | number; amount: number }

export interface VisitStats {
  visitCount: number;
  ltv: number;
  avgSpend: number;
  firstVisitAt: number | null;
  lastVisitAt: number | null;
  avgIntervalDays: number | null;
}

export function visitStats(visits: Visit[]): VisitStats {
  const vs = visits.map((v) => ({ at: +v.at, amount: v.amount })).sort((a, b) => a.at - b.at);
  const ltv = vs.reduce((s, v) => s + v.amount, 0);
  const n = vs.length;
  let avgIntervalDays: number | null = null;
  if (n >= 2) avgIntervalDays = Math.round(((vs[n - 1].at - vs[0].at) / 86400000 / (n - 1)) * 10) / 10;
  return {
    visitCount: n, ltv, avgSpend: n ? Math.round(ltv / n) : 0,
    firstVisitAt: n ? vs[0].at : null, lastVisitAt: n ? vs[n - 1].at : null, avgIntervalDays,
  };
}

export type Lifecycle = 'NEW' | 'ACTIVE' | 'DUE' | 'OVERDUE' | 'DORMANT' | 'PROSPECT';

/**
 * DUE: past the customer's own cycle; OVERDUE: 1.5× cycle; DORMANT: over dormantDays.
 * Falls back to defaultCycleDays when the customer has <2 visits.
 */
export function lifecycle(stats: Pick<VisitStats, 'visitCount' | 'lastVisitAt' | 'avgIntervalDays'>, now: number, opts = { defaultCycleDays: 45, dormantDays: 180 }): Lifecycle {
  if (!stats.visitCount || stats.lastVisitAt === null) return 'PROSPECT';
  const since = (now - stats.lastVisitAt) / 86400000;
  if (since >= opts.dormantDays) return 'DORMANT';
  const cycle = stats.avgIntervalDays ?? opts.defaultCycleDays;
  if (since >= cycle * 1.5) return 'OVERDUE';
  if (since >= cycle) return 'DUE';
  return stats.visitCount === 1 ? 'NEW' : 'ACTIVE';
}

export const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  NEW: '新規', ACTIVE: '通常', DUE: '来店周期超過', OVERDUE: 'フォロー要', DORMANT: '休眠', PROSPECT: '未来店',
};

/** Share of customers whose first visit is in range and who came back within `withinDays`. */
export function repeatRate(firstAndSecond: { first: number; second: number | null }[], withinDays = 90): number {
  if (!firstAndSecond.length) return 0;
  const back = firstAndSecond.filter((c) => c.second !== null && c.second - c.first <= withinDays * 86400000).length;
  return back / firstAndSecond.length;
}

export function pct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

export function groupSum<T>(rows: T[], key: (r: T) => string, val: (r: T) => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) { const k = key(r); out[k] = (out[k] ?? 0) + val(r); }
  return out;
}
