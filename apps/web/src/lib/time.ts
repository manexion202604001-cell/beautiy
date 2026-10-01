import { TZDate } from '@date-fns/tz';

/**
 * Timezone helpers. All instants from the API are UTC ISO strings; the UI shows and
 * reasons about them in the shop timezone (default Asia/Tokyo). Local calendar dates
 * are handled as plain 'YYYY-MM-DD' strings to avoid host-timezone surprises.
 */
export const DEFAULT_TZ = 'Asia/Tokyo';

const partsCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    });
    partsCache.set(tz, f);
  }
  return f;
}

export interface ZonedParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** minutes since local midnight */
  minutes: number;
  weekday: number; // 0=Sun
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(instant: string | Date, tz = DEFAULT_TZ): ZonedParts {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  const p: Record<string, string> = {};
  for (const part of partsFormatter(tz).formatToParts(d)) p[part.type] = part.value;
  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  const hour = Number(p.hour) % 24;
  const minute = Number(p.minute);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${String(hour).padStart(2, '0')}:${p.minute}`,
    year,
    month,
    day,
    hour,
    minute,
    minutes: hour * 60 + minute,
    weekday: WD[p.weekday ?? 'Sun'] ?? 0,
  };
}

/** Today's local date in tz */
export function todayIn(tz = DEFAULT_TZ, now: Date = new Date()): string {
  return zonedParts(now, tz).date;
}

/** Combine local date + HH:mm in tz → UTC ISO string */
export function zonedToIso(date: string, time: string, tz = DEFAULT_TZ): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  // TZDate#toISOString keeps the zone offset; normalize to UTC "Z" so it compares with API instants
  return new Date(new TZDate(y, m - 1, d, hh, mm, 0, tz).getTime()).toISOString();
}

/** Local date + minutes since midnight → ISO */
export function zonedMinutesToIso(date: string, minutes: number, tz = DEFAULT_TZ): string {
  return zonedToIso(date, minutesToHhmm(minutes), tz);
}

export function minutesToHhmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function hhmmToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return h * 60 + (m || 0);
}

function parseDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function fmtDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function addDays(date: string, days: number): string {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fmtDate(d);
}

export function addMonths(date: string, months: number): string {
  const d = parseDate(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return fmtDate(d);
}

/** 0 = Sunday */
export function weekdayOf(date: string): number {
  return parseDate(date).getUTCDay();
}

/** Monday-start week */
export function startOfWeek(date: string): string {
  const wd = weekdayOf(date);
  return addDays(date, -((wd + 6) % 7));
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function daysInMonth(date: string): number {
  const d = parseDate(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseDate(a).getTime() - parseDate(b).getTime()) / 86_400_000);
}
