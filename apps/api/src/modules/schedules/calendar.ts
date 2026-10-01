import type { Ctx } from '../../auth/actor.js';
import { dateRange, dayBounds, intersectRanges, subtractRanges, weekdayOf, zonedDateTime, type Range } from '../../lib/time.js';

/**
 * Pure schedule computation over pre-loaded rows, so availability can evaluate
 * many staff × many days with a handful of queries.
 */
export interface ScheduleData {
  tz: string;
  businessHours: { weekday: number; open_time: string; close_time: string }[];
  exceptions: Map<string, { is_closed: boolean; open_time: string | null; close_time: string | null }>;
  weekly: Map<string, { weekday: number; start_time: string; end_time: string }[]>; // staffId -> rows
  shifts: Map<string, { shift_type: string; start_time: string | null; end_time: string | null; shop_id: string }[]>; // `${staffId}:${date}` -> rows
  blocks: { staff_id: string | null; resource_id: string | null; start_at: Date; end_at: Date }[];
  shopId: string;
}

export async function loadScheduleData(ctx: Ctx, shopId: string, staffIds: string[], from: string, to: string, tz: string): Promise<ScheduleData> {
  const start = dayBounds(from, tz).start;
  const end = dayBounds(to, tz).end;
  const anyStaff = staffIds.length ? staffIds : ['00000000-0000-0000-0000-000000000000'];
  const [hours, exceptions, weekly, shifts, blocks] = await Promise.all([
    ctx.trx.selectFrom('shop_business_hours').select(['weekday', 'open_time', 'close_time']).where('shop_id', '=', shopId).execute(),
    ctx.trx
      .selectFrom('shop_calendar_exceptions')
      .select(['date', 'is_closed', 'open_time', 'close_time'])
      .where('shop_id', '=', shopId)
      .where('date', '>=', from)
      .where('date', '<=', to)
      .execute(),
    ctx.trx
      .selectFrom('staff_weekly_schedules')
      .select(['staff_id', 'weekday', 'start_time', 'end_time'])
      .where('shop_id', '=', shopId)
      .where('staff_id', 'in', anyStaff)
      .execute(),
    ctx.trx
      .selectFrom('staff_shifts')
      .select(['staff_id', 'date', 'shift_type', 'start_time', 'end_time', 'shop_id'])
      .where('staff_id', 'in', anyStaff)
      .where('date', '>=', from)
      .where('date', '<=', to)
      .execute(),
    ctx.trx
      .selectFrom('schedule_blocks')
      .select(['staff_id', 'resource_id', 'start_at', 'end_at'])
      .where('shop_id', '=', shopId)
      .where('start_at', '<', end)
      .where('end_at', '>', start)
      .execute(),
  ]);
  const weeklyMap = new Map<string, { weekday: number; start_time: string; end_time: string }[]>();
  for (const w of weekly) weeklyMap.set(w.staff_id, [...(weeklyMap.get(w.staff_id) ?? []), w]);
  const shiftMap = new Map<string, { shift_type: string; start_time: string | null; end_time: string | null; shop_id: string }[]>();
  for (const s of shifts) {
    const key = `${s.staff_id}:${s.date}`;
    shiftMap.set(key, [...(shiftMap.get(key) ?? []), s]);
  }
  return {
    tz,
    shopId,
    businessHours: hours,
    exceptions: new Map(exceptions.map((e) => [e.date, e])),
    weekly: weeklyMap,
    shifts: shiftMap,
    blocks,
  };
}

export function shopOpenRanges(data: ScheduleData, date: string): Range[] {
  const ex = data.exceptions.get(date);
  if (ex) {
    if (ex.is_closed || !ex.open_time || !ex.close_time) return [];
    return [{ start: zonedDateTime(date, ex.open_time, data.tz), end: zonedDateTime(date, ex.close_time, data.tz) }];
  }
  const wd = weekdayOf(date, data.tz);
  return data.businessHours
    .filter((h) => h.weekday === wd)
    .map((h) => ({ start: zonedDateTime(date, h.open_time, data.tz), end: zonedDateTime(date, h.close_time, data.tz) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Staff working ranges at this shop on a date:
 *  1. date-specific shifts (any row for the date replaces the weekly pattern; 'off' = not working)
 *  2. weekly pattern at this shop
 *  3. no pattern configured at all → follows shop hours (small salons without shift management)
 * Always intersected with shop open hours, minus staff blocks.
 */
export function staffWorkRanges(data: ScheduleData, staffId: string, date: string): Range[] {
  const open = shopOpenRanges(data, date);
  if (open.length === 0) return [];
  let work: Range[];
  const shifts = data.shifts.get(`${staffId}:${date}`);
  if (shifts && shifts.length) {
    work = shifts
      .filter((s) => s.shift_type === 'work' && s.shop_id === data.shopId && s.start_time && s.end_time)
      .map((s) => ({ start: zonedDateTime(date, s.start_time!, data.tz), end: zonedDateTime(date, s.end_time!, data.tz) }));
  } else {
    const weekly = data.weekly.get(staffId);
    if (weekly && weekly.length) {
      const wd = weekdayOf(date, data.tz);
      work = weekly.filter((w) => w.weekday === wd).map((w) => ({ start: zonedDateTime(date, w.start_time, data.tz), end: zonedDateTime(date, w.end_time, data.tz) }));
    } else {
      work = open;
    }
  }
  const blocks = data.blocks.filter((b) => b.staff_id === staffId).map((b) => ({ start: b.start_at, end: b.end_at }));
  return subtractRanges(intersectRanges(work, open), blocks);
}

export function resourceBlockedRanges(data: ScheduleData, resourceId: string): Range[] {
  return data.blocks.filter((b) => b.resource_id === resourceId).map((b) => ({ start: b.start_at, end: b.end_at }));
}

export function datesBetween(from: string, to: string) {
  return dateRange(from, to);
}
