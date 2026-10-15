/**
 * 予約受付設定 (the shop's rules for bookings made online) and スタッフ別 予約設定.
 * Pure functions over the pre-loaded ScheduleData so availability can test many slots cheaply.
 *
 *  shop  : 受付開始 (N months / N days ahead) · 受付締切 (minutes before, or a day earlier) ·
 *          計算方法 (calendar / business days) · 受付可能数 (per weekday, holiday, default) ·
 *          開始時刻が同じ予約 · 営業時間外の予約
 *  staff : 何日先まで · 当日の締め切り · 同時刻に予約可能な人数 · 開始時刻が同じ予約 · 営業時間外
 *          — a staff member with their own 予約設定 uses those instead of the shop's.
 *
 * The window / capacity / same-start rules apply to online bookings only; bookings entered by
 * staff keep their own override (営業時間外でも登録). 同時刻に予約可能な人数 applies to both.
 */
import { DateTime } from 'luxon';
import { addMinutes, dayBounds, localDate, weekdayOf, zonedDateTime, type Range } from '../../lib/time.js';
import { shopOpenRanges, staffExtendedRanges, staffWorkRanges, usesHolidayHours, type ScheduleData, type StaffReservationSettings } from '../schedules/calendar.js';

/** An existing booking of a staff member: occupied range, the lane it holds and its start time */
export interface BusyRange extends Range {
  lane: number;
  startAt: Date;
}

export function staffReservation(data: ScheduleData, staffId: string): StaffReservationSettings | null {
  return data.staffSettings.get(staffId)?.reservation ?? null;
}

/** 同時刻に予約可能な人数: one at a time unless the staff member has their own 予約設定 */
export function staffMaxConcurrent(data: ScheduleData, staffId: string): number {
  return staffReservation(data, staffId)?.maxConcurrent ?? 1;
}

export function acceptsSameStart(data: ScheduleData, staffId: string): boolean {
  return staffReservation(data, staffId)?.acceptSameStartTime ?? data.settings.booking.acceptSameStartTime;
}

export function acceptsOutsideHours(data: ScheduleData, staffId: string): boolean {
  return staffReservation(data, staffId)?.acceptOutsideHours ?? data.settings.booking.acceptOutsideHours;
}

/** Lowest lane (0 … max-1) with nothing overlapping the range; null = the staff member is full */
export function freeLane(range: Range, busy: BusyRange[], maxConcurrent: number): number | null {
  for (let lane = 0; lane < maxConcurrent; lane++) {
    if (!busy.some((b) => b.lane === lane && b.start < range.end && range.start < b.end)) return lane;
  }
  return null;
}

/** Ranges an online / staff booking may be placed in for this staff member on this day */
export function bookableRanges(data: ScheduleData, staffId: string, date: string, publicBooking: boolean | undefined): Range[] {
  return publicBooking && acceptsOutsideHours(data, staffId) ? staffExtendedRanges(data, staffId, date) : staffWorkRanges(data, staffId, date);
}

/** 受付可能数 for the day: holiday row (when holiday hours are on) → weekday row → default → no limit */
export function shopCapacity(data: ScheduleData, date: string): number | null {
  const c = data.settings.capacity;
  if (usesHolidayHours(data, date)) return c.holiday ?? c.default;
  return c.weekdays[weekdayOf(date, data.tz)] ?? c.default;
}

/** Highest number of ranges running at the same moment inside [start, end) */
export function peakOverlap(ranges: Range[], start: Date, end: Date): number {
  const points: { at: number; delta: number }[] = [];
  for (const r of ranges) {
    const s = Math.max(r.start.getTime(), start.getTime());
    const e = Math.min(r.end.getTime(), end.getTime());
    if (e > s) points.push({ at: s, delta: 1 }, { at: e, delta: -1 });
  }
  points.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  for (const p of points) {
    current += p.delta;
    if (current > peak) peak = current;
  }
  return peak;
}

const openDayMemo = new WeakMap<ScheduleData, Map<string, boolean>>();

/** The shop is open on this local date (定休日・臨時休業日・祝日の営業時間 considered) */
export function isOpenDay(data: ScheduleData, date: string): boolean {
  let memo = openDayMemo.get(data);
  if (!memo) openDayMemo.set(data, (memo = new Map()));
  let open = memo.get(date);
  if (open === undefined) memo.set(date, (open = shopOpenRanges(data, date).length > 0));
  return open;
}

const shiftDate = (date: string, days: number) => DateTime.fromISO(date).plus({ days }).toISODate()!;

/** Open days d with from < d <= to */
function openDaysAfter(data: ScheduleData, from: string, to: string): number {
  let n = 0;
  for (let d = shiftDate(from, 1); d <= to; d = shiftDate(d, 1)) if (isOpenDay(data, d)) n++;
  return n;
}

/**
 * The day `n` days before `date` — calendar days, or days the shop is open when the shop counts
 * in business days. null when that day is before `floor` (today): the deadline has passed.
 */
function daysBefore(data: ScheduleData, date: string, n: number, floor: string): string | null {
  if (data.settings.booking.calcMethod !== 'business_days') {
    const d = shiftDate(date, -n);
    return d < floor ? null : d;
  }
  let left = n;
  for (let d = shiftDate(date, -1); d >= floor; d = shiftDate(d, -1)) {
    if (isOpenDay(data, d) && --left === 0) return d;
  }
  return null;
}

/** 受付開始 / 受付締切 for an online booking starting at `start`; null = within the window */
export function bookingWindowViolation(data: ScheduleData, staffId: string, start: Date, now: Date): 'lead_time' | 'horizon' | null {
  const tz = data.tz;
  const b = data.settings.booking;
  const own = staffReservation(data, staffId);
  const today = localDate(now, tz);
  const date = localDate(start, tz);

  // ---- 受付締切
  if (own) {
    if (start < addMinutes(now, own.sameDayCutoffHours * 60)) return 'lead_time';
  } else if (b.cutoffType === 'days_before') {
    const cutoffDay = daysBefore(data, date, b.cutoffDaysBefore, today);
    if (!cutoffDay) return 'lead_time';
    const cutoff = b.cutoffTime === '24:00' ? dayBounds(cutoffDay, tz).end : zonedDateTime(cutoffDay, b.cutoffTime, tz);
    if (now >= cutoff) return 'lead_time';
  } else if (start < addMinutes(now, b.leadTimeMin)) {
    return 'lead_time';
  }

  // ---- 受付開始
  if (own) {
    const tooFar = b.calcMethod === 'business_days' ? openDaysAfter(data, today, date) > own.advanceBookingDays : date > shiftDate(today, own.advanceBookingDays);
    if (tooFar) return 'horizon';
  } else if (b.advanceMonths !== null) {
    if (date > lastBookableDate(today, b.advanceMonths)) return 'horizon';
  } else if (start > addMinutes(now, b.horizonDays * 24 * 60)) {
    return 'horizon';
  }
  return null;
}

/** 受付開始「Nヶ月先まで」: the last day of (this month + N months) */
export function lastBookableDate(today: string, advanceMonths: number): string {
  return DateTime.fromISO(today).plus({ months: advanceMonths }).endOf('month').toISODate()!;
}
