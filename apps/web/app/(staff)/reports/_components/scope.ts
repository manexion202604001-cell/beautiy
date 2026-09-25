// Report scope/period parsing shared by report pages and CSV exports (server-only).
import type { StaffContext } from '@/lib/server/session';
import { resolvePeriod, type Period, type RangeKey } from '@/lib/server/analytics';

export type ScopeMode = 'shop' | 'all' | 'compare';
export type SP = Record<string, string | string[] | undefined>;

export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export interface ReportScope {
  mode: ScopeMode;
  shopIds: string[];
  shops: StaffContext['shops'];
  label: string;
  multi: boolean;
  period: Period;
  gran: 'day' | 'month';
}

export function reportScope(ctx: StaffContext, sp: SP, fallback: RangeKey = 'thisMonth'): ReportScope {
  const multi = ctx.shops.length > 1;
  const raw = one(sp.scope);
  const mode: ScopeMode = multi && (raw === 'all' || raw === 'compare') ? raw : 'shop';
  const shops = mode === 'shop' ? [ctx.shop] : ctx.shops;
  const period = resolvePeriod({ range: one(sp.range), from: one(sp.from), to: one(sp.to) }, ctx.shop.timezone, new Date(), fallback);
  const g = one(sp.gran);
  const gran: 'day' | 'month' = g === 'day' || g === 'month' ? g : period.days > 62 ? 'month' : 'day';
  return {
    mode, shops, shopIds: shops.map((s) => s.id), multi, period, gran,
    label: mode === 'shop' ? ctx.shop.name : mode === 'all' ? `全店舗合計（${ctx.shops.length}店舗）` : '店舗別比較',
  };
}

/** Build a query string from current params with overrides (undefined/'' removes a key). */
export function qs(sp: SP, patch: Record<string, string | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) { const s = one(v); if (s) u.set(k, s); }
  for (const [k, v] of Object.entries(patch)) { if (v === undefined || v === '') u.delete(k); else u.set(k, v); }
  const s = u.toString();
  return s ? `?${s}` : '';
}
