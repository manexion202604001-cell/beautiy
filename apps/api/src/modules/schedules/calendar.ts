import { z } from 'zod';
import type { Ctx } from '../../auth/actor.js';
import { isJpHoliday } from '../../lib/jp-holidays.js';
import { parseShopSettings, type ShopSettings } from '../../lib/shop-settings.js';
import { dateRange, dayBounds, intersectRanges, localDate, subtractRanges, weekdayOf, zonedDateTime, type Range } from '../../lib/time.js';

/** スタッフ別 予約設定 (staff_booking_settings.reservation): replaces the shop's rules for that staff member */
export const staffReservationSchema = z.object({
  /** 何日先まで予約を受け付ける */
  advanceBookingDays: z.number().int().min(1).max(730),
  /** 当日予約の締め切り: N hours before the start (0 = no limit) */
  sameDayCutoffHours: z.number().int().min(0).max(24),
  /** 同時刻に予約可能な人数 */
  maxConcurrent: z.number().int().min(1).max(10),
  acceptSameStartTime: z.boolean(),
  acceptOutsideHours: z.boolean(),
});
export type StaffReservationSettings = z.infer<typeof staffReservationSchema>;

export interface StaffBookingSettings {
  weeklyAllClosed: boolean;
  reservation: StaffReservationSettings | null;
}

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
  /** shop settings (holiday hours, capacity, online booking rules) */
  settings: ShopSettings;
  /** staffId -> individual settings at this shop (only staff who have any) */
  staffSettings: Map<string, StaffBookingSettings>;
}

export async function loadScheduleData(ctx: Ctx, shopId: string, staffIds: string[], from: string, to: string, tz: string): Promise<ScheduleData> {
  const start = dayBounds(from, tz).start;
  const end = dayBounds(to, tz).end;
  const anyStaff = staffIds.length ? staffIds : ['00000000-0000-0000-0000-000000000000'];
  // closures are read from today on as well: counting business days needs every day up to the date asked for
  const today = localDate(new Date(), tz);
  const exceptionsFrom = today < from ? today : from;
  const [hours, exceptions, weekly, shifts, blocks, shop, staffSettings] = await Promise.all([
    ctx.trx.selectFrom('shop_business_hours').select(['weekday', 'open_time', 'close_time']).where('shop_id', '=', shopId).execute(),
    ctx.trx
      .selectFrom('shop_calendar_exceptions')
      .select(['date', 'is_closed', 'open_time', 'close_time'])
      .where('shop_id', '=', shopId)
      .where('date', '>=', exceptionsFrom)
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
    ctx.trx.selectFrom('shops').select('settings').where('id', '=', shopId).executeTakeFirst(),
    ctx.trx
      .selectFrom('staff_booking_settings')
      .select(['staff_id', 'weekly_all_closed', 'reservation'])
      .where('shop_id', '=', shopId)
      .where('staff_id', 'in', anyStaff)
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
    settings: parseShopSettings(shop?.settings),
    staffSettings: new Map(staffSettings.map((s) => [s.staff_id, { weeklyAllClosed: s.weekly_all_closed, reservation: parseStaffReservation(s.reservation) }])),
  };
}

export function parseStaffReservation(raw: unknown): StaffReservationSettings | null {
  const parsed = staffReservationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** 祝日の営業時間を個別に設定する: on a public holiday the holiday row replaces the weekday row */
export function usesHolidayHours(data: Pick<ScheduleData, 'settings'>, date: string): boolean {
  return data.settings.hours.holidayEnabled && isJpHoliday(date);
}

export function shopOpenRanges(data: ScheduleData, date: string): Range[] {
  const ex = data.exceptions.get(date);
  if (ex) {
    if (ex.is_closed || !ex.open_time || !ex.close_time) return [];
    return [{ start: zonedDateTime(date, ex.open_time, data.tz), end: zonedDateTime(date, ex.close_time, data.tz) }];
  }
  if (usesHolidayHours(data, date)) {
    const h = data.settings.hours;
    if (h.holidayClosed || h.holidayCloseTime <= h.holidayOpenTime) return [];
    return [{ start: zonedDateTime(date, h.holidayOpenTime, data.tz), end: zonedDateTime(date, h.holidayCloseTime, data.tz) }];
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
 *  3. no pattern configured at all → follows shop hours (small salons without shift management);
 *     スタッフ別 営業時間 saved with every day 休み → not working
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
      work = data.staffSettings.get(staffId)?.weeklyAllClosed ? [] : open;
    }
  }
  const blocks = data.blocks.filter((b) => b.staff_id === staffId).map((b) => ({ start: b.start_at, end: b.end_at }));
  return subtractRanges(intersectRanges(work, open), blocks);
}

/**
 * 営業時間外の予約を受付する: on a day the staff member works, the whole day is open to online
 * bookings (their blocks still apply). A day off / a closed day stays closed.
 */
export function staffExtendedRanges(data: ScheduleData, staffId: string, date: string): Range[] {
  if (staffWorkRanges(data, staffId, date).length === 0) return [];
  const blocks = data.blocks.filter((b) => b.staff_id === staffId).map((b) => ({ start: b.start_at, end: b.end_at }));
  return subtractRanges([dayBounds(date, data.tz)], blocks);
}

export function resourceBlockedRanges(data: ScheduleData, resourceId: string): Range[] {
  return data.blocks.filter((b) => b.resource_id === resourceId).map((b) => ({ start: b.start_at, end: b.end_at }));
}

export function datesBetween(from: string, to: string) {
  return dateRange(from, to);
}
