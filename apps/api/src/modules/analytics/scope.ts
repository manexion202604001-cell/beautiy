import { DateTime } from 'luxon';
import { accessibleShopIds, assertShopAccess, can, type Ctx } from '../../auth/actor.js';
import type { Permission } from '../../auth/permissions.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { DEFAULT_TZ, localDate } from '../../lib/time.js';

/**
 * Report scope = which shops (and, for analytics.read_own, which staff) a caller may see.
 *  - analytics.read (or sales.read for sales reports): any accessible shop; all-shops roles see the whole org
 *  - analytics.read_own (stylists): only their own staff metrics — shop totals / other staff → 403
 */
export interface ShopInfo {
  id: string;
  name: string;
  timezone: string;
}

export interface Scope {
  shops: ShopInfo[];
  shopIds: string[];
  /** set when the caller may only see their own staff metrics */
  ownStaffId: string | null;
  /** timezone used for customer-level date boundaries (shop TZ; org TZ when shops differ) */
  tz: string;
}

export interface ScopeOptions {
  /** permissions granting full (shop-level) access */
  full?: Permission[];
  /** permissions granting own-staff access; omit when the report has no own-staff variant */
  own?: Permission[];
}

const NIL = '00000000-0000-0000-0000-000000000000';

export async function resolveScope(ctx: Ctx, shopId: string | undefined, opts: ScopeOptions = {}): Promise<Scope> {
  const fullPerms = opts.full ?? ['analytics.read'];
  const ownPerms = opts.own ?? [];
  const full = fullPerms.some((p) => can(ctx.actor, p));
  const own = !full && ownPerms.some((p) => can(ctx.actor, p)) && ctx.actor.kind === 'staff';
  if (!full && !own) {
    throw Errors.forbidden(`権限がありません (${[...fullPerms, ...ownPerms].join(' | ')})`, 'FORBIDDEN', { permissions: [...fullPerms, ...ownPerms] });
  }

  let q = ctx.trx.selectFrom('shops').select(['id', 'name', 'timezone']).where('deleted_at', 'is', null).orderBy('created_at');
  if (shopId) {
    assertShopAccess(ctx.actor, shopId);
    q = q.where('id', '=', shopId);
  } else {
    const ids = accessibleShopIds(ctx.actor);
    if (ids) q = q.where('id', 'in', ids.length ? [...ids] : [NIL]);
  }
  const shops = await q.execute();
  if (shopId && shops.length === 0) throw Errors.notFound('店舗', shopId);

  const tzs = new Set(shops.map((s) => s.timezone));
  let tz = shops[0]?.timezone ?? DEFAULT_TZ;
  if (tzs.size > 1) {
    const org = await ctx.trx.selectFrom('organizations').select('timezone').where('id', '=', ctx.actor.organizationId).executeTakeFirst();
    tz = org?.timezone ?? DEFAULT_TZ;
  }
  return {
    shops,
    shopIds: shops.length ? shops.map((s) => s.id) : [NIL],
    ownStaffId: own && ctx.actor.kind === 'staff' ? ctx.actor.staffId : null,
    tz,
  };
}

/** Stylist (own-only) callers may only request their own staff id */
export function assertOwnStaff(scope: Scope, staffId: string | undefined): void {
  if (scope.ownStaffId && staffId && staffId !== scope.ownStaffId) {
    throw Errors.forbidden('他のスタッフの分析は閲覧できません', 'ANALYTICS_OWN_ONLY');
  }
}

export function requireFullScope(scope: Scope, what = '店舗全体の集計'): void {
  if (scope.ownStaffId) throw Errors.forbidden(`${what}を閲覧する権限がありません (analytics.read)`, 'ANALYTICS_OWN_ONLY');
}

// ---------------------------------------------------------------- dates

export interface DateRange {
  from: string;
  to: string;
}

const MAX_RANGE_DAYS = 731;

/** Default range: first day of the current month .. today (local) */
export function resolveRange(input: { from?: string; to?: string }, tz: string): DateRange {
  const today = localDate(new Date(), tz);
  const to = input.to ?? today;
  const from = input.from ?? `${to.slice(0, 7)}-01`;
  if (from > to) throw Errors.validation('開始日は終了日以前を指定してください', { from, to });
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw Errors.validation(`集計期間は最大${MAX_RANGE_DAYS}日です`);
  return { from, to };
}

export function daysBetween(from: string, to: string): number {
  return Math.round(DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days);
}

export function addDaysIso(date: string, days: number): string {
  return DateTime.fromISO(date).plus({ days }).toISODate()!;
}

export type CompareTo = 'previous_period' | 'previous_year' | 'none';

/**
 * previous_period: the same number of days immediately before `from`
 * previous_year:   the same calendar dates one year earlier (Feb 29 → Feb 28)
 */
export function compareRange(range: DateRange, mode: CompareTo): DateRange | null {
  if (mode === 'none') return null;
  if (mode === 'previous_year') {
    return {
      from: DateTime.fromISO(range.from).minus({ years: 1 }).toISODate()!,
      to: DateTime.fromISO(range.to).minus({ years: 1 }).toISODate()!,
    };
  }
  const len = daysBetween(range.from, range.to) + 1;
  return { from: addDaysIso(range.from, -len), to: addDaysIso(range.from, -1) };
}

/** Period bucket key: day → YYYY-MM-DD, week → Monday (ISO week start), month → YYYY-MM */
export function bucketKey(date: string, groupBy: 'day' | 'week' | 'month'): string {
  if (groupBy === 'day') return date;
  if (groupBy === 'month') return date.slice(0, 7);
  return DateTime.fromISO(date).startOf('week').toISODate()!;
}

/** All bucket keys covering the range (so empty periods are returned as zero rows) */
export function bucketKeys(range: DateRange, groupBy: 'day' | 'week' | 'month'): string[] {
  const keys: string[] = [];
  let d = DateTime.fromISO(range.from);
  const end = DateTime.fromISO(range.to);
  while (d <= end) {
    const k = bucketKey(d.toISODate()!, groupBy);
    if (keys[keys.length - 1] !== k) keys.push(k);
    d = d.plus({ days: 1 });
  }
  return keys;
}

// ---------------------------------------------------------------- numbers

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** n / d as a percentage with 1 decimal; null when d = 0 */
export function pct(n: number, d: number): number | null {
  return d === 0 ? null : round1((n / d) * 100);
}

/** Change rate in % ((cur − prev) / prev); null when prev = 0 */
export function delta(cur: number, prev: number): number | null {
  return prev === 0 ? null : round1(((cur - prev) / prev) * 100);
}

/** integer division rounded half up; null when d = 0 */
export function ratio(n: number, d: number): number | null {
  return d === 0 ? null : Math.round(n / d);
}

export function deltas<T extends Record<string, number | null>>(cur: T, prev: T): Record<keyof T, number | null> {
  const out = {} as Record<keyof T, number | null>;
  for (const k of Object.keys(cur) as (keyof T)[]) {
    const c = cur[k];
    const p = prev[k];
    out[k] = typeof c === 'number' && typeof p === 'number' ? delta(c, p) : null;
  }
  return out;
}

// ---------------------------------------------------------------- audit

/** 要件 2.1: 売上閲覧は監査ログ対象 */
export async function auditSalesView(ctx: Ctx, report: string, scope: Scope, metadata: Record<string, unknown>) {
  await audit(ctx, {
    action: 'sales.view',
    resourceType: 'analytics',
    resourceId: null,
    shopId: scope.shops.length === 1 ? scope.shops[0]!.id : null,
    metadata: { report, shopIds: scope.shops.map((s) => s.id), ownStaffId: scope.ownStaffId, ...metadata },
  });
}
