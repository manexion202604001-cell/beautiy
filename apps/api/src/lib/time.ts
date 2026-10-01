import { DateTime, Interval } from 'luxon';

export const DEFAULT_TZ = 'Asia/Tokyo';

/** Combine a local date ('YYYY-MM-DD') and time ('HH:mm[:ss]') in a timezone into a UTC Date */
export function zonedDateTime(date: string, time: string, tz: string): Date {
  const dt = DateTime.fromISO(`${date}T${time.length === 5 ? `${time}:00` : time}`, { zone: tz });
  if (!dt.isValid) throw new Error(`Invalid date/time: ${date} ${time} (${tz})`);
  return dt.toJSDate();
}

/** Start/end (exclusive) of a local day in UTC */
export function dayBounds(date: string, tz: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(date, { zone: tz }).startOf('day');
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}

/** Local date string for an instant */
export function localDate(instant: Date, tz: string): string {
  return DateTime.fromJSDate(instant, { zone: tz }).toISODate()!;
}

/** Weekday 0=Sunday..6=Saturday for a local date */
export function weekdayOf(date: string, tz: string): number {
  return DateTime.fromISO(date, { zone: tz }).weekday % 7;
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

export function diffMinutes(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 60_000);
}

export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Inclusive list of local dates between from and to */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  let d = DateTime.fromISO(from);
  const end = DateTime.fromISO(to);
  while (d <= end) {
    out.push(d.toISODate()!);
    d = d.plus({ days: 1 });
  }
  return out;
}

export function formatJst(d: Date, fmt = 'yyyy/MM/dd HH:mm', tz = DEFAULT_TZ): string {
  return DateTime.fromJSDate(d, { zone: tz }).setLocale('ja').toFormat(fmt);
}

/** Half-open interval arithmetic: subtract busy ranges from free ranges */
export type Range = { start: Date; end: Date };

export function subtractRanges(free: Range[], busy: Range[]): Range[] {
  let result = free.map((r) => Interval.fromDateTimes(r.start, r.end));
  for (const b of busy) {
    const bi = Interval.fromDateTimes(b.start, b.end);
    result = result.flatMap((r) => r.difference(bi));
  }
  return result
    .filter((i) => i.isValid && i.length('minutes') > 0)
    .map((i) => ({ start: i.start!.toJSDate(), end: i.end!.toJSDate() }));
}

export function intersectRanges(a: Range[], b: Range[]): Range[] {
  const out: Range[] = [];
  for (const x of a) {
    for (const y of b) {
      const start = x.start > y.start ? x.start : y.start;
      const end = x.end < y.end ? x.end : y.end;
      if (start < end) out.push({ start, end });
    }
  }
  return out;
}
