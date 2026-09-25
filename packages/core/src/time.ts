// Timezone helpers. All DB timestamps are UTC; shop-local calendars use IANA zones.

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(timeZone: string) {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface LocalParts { date: string; minutes: number; weekday: number; year: number; month: number; day: number; hour: number; minute: number }

export function toLocalParts(date: Date, timeZone: string): LocalParts {
  const p: Record<string, string> = {};
  for (const part of dtf(timeZone).formatToParts(date)) p[part.type] = part.value;
  const year = +p.year, month = +p.month, day = +p.day, hour = +p.hour, minute = +p.minute;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: hour * 60 + minute,
    weekday: WEEKDAYS[p.weekday] ?? 0,
    year, month, day, hour, minute,
  };
}

/** Offset (minutes) of timeZone from UTC at the given instant. Asia/Tokyo → 540. */
export function tzOffsetMinutes(date: Date, timeZone: string): number {
  const p: Record<string, string> = {};
  for (const part of dtf(timeZone).formatToParts(date)) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** Convert a shop-local date (YYYY-MM-DD) + minutes-from-midnight into a UTC Date. */
export function localToUtc(dateStr: string, minutes: number, timeZone: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const off1 = tzOffsetMinutes(new Date(guess), timeZone);
  let t = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(new Date(t), timeZone);
  if (off2 !== off1) t = guess - off2 * 60000;
  return new Date(t);
}

export function isDateStr(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

export function addDays(dateStr: string, n: number): string {
  const t = Date.parse(dateStr + 'T00:00:00Z') + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function weekdayOf(dateStr: string): number {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay();
}

/** Monday-start week containing dateStr. */
export function startOfWeek(dateStr: string): string {
  const wd = weekdayOf(dateStr);
  return addDays(dateStr, wd === 0 ? -6 : 1 - wd);
}

export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
}

export function todayIn(timeZone: string, now = new Date()): string {
  return toLocalParts(now, timeZone).date;
}

export function minutesToHHMM(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function hhmmToMinutes(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`invalid time: ${s}`);
  return +m[1] * 60 + +m[2];
}

const JA_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
export function jaWeekday(n: number): string { return JA_WEEKDAYS[n] ?? ''; }
