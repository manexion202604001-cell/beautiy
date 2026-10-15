/**
 * Japanese public holidays (国民の祝日に関する法律, as in force from 2022).
 * Computed, no data file: fixed dates, Happy Monday holidays, the two equinoxes (astronomical
 * approximation valid for 1980–2099), 振替休日 and 国民の休日.
 */

const cache = new Map<number, Set<string>>();

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const weekday = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

function nthMonday(y: number, m: number, n: number): number {
  const first = weekday(y, m, 1);
  return 1 + ((8 - first) % 7) + (n - 1) * 7;
}

function springEquinoxDay(y: number): number {
  return Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}

function autumnEquinoxDay(y: number): number {
  return Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}

function addDay(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function holidaysOf(year: number): Set<string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const named = new Set<string>([
    iso(year, 1, 1), // 元日
    iso(year, 1, nthMonday(year, 1, 2)), // 成人の日
    iso(year, 2, 11), // 建国記念の日
    iso(year, 2, 23), // 天皇誕生日
    iso(year, 3, springEquinoxDay(year)), // 春分の日
    iso(year, 4, 29), // 昭和の日
    iso(year, 5, 3), // 憲法記念日
    iso(year, 5, 4), // みどりの日
    iso(year, 5, 5), // こどもの日
    iso(year, 7, nthMonday(year, 7, 3)), // 海の日
    iso(year, 8, 11), // 山の日
    iso(year, 9, nthMonday(year, 9, 3)), // 敬老の日
    iso(year, 9, autumnEquinoxDay(year)), // 秋分の日
    iso(year, 10, nthMonday(year, 10, 2)), // スポーツの日
    iso(year, 11, 3), // 文化の日
    iso(year, 11, 23), // 勤労感謝の日
  ]);
  const all = new Set(named);
  // 振替休日: a holiday on Sunday moves to the next day that is not itself a holiday
  for (const h of named) {
    const [y, m, d] = h.split('-').map(Number) as [number, number, number];
    if (weekday(y, m, d) !== 0) continue;
    let next = addDay(h, 1);
    while (named.has(next)) next = addDay(next, 1);
    all.add(next);
  }
  // 国民の休日: a weekday between two holidays
  for (const h of named) {
    const between = addDay(h, 1);
    const [y, m, d] = between.split('-').map(Number) as [number, number, number];
    if (named.has(addDay(h, 2)) && !all.has(between) && weekday(y, m, d) !== 0) all.add(between);
  }
  cache.set(year, all);
  return all;
}

/** true when the local date ('YYYY-MM-DD') is a Japanese public holiday (incl. 振替休日 / 国民の休日) */
export function isJpHoliday(date: string): boolean {
  const year = Number(date.slice(0, 4));
  if (!Number.isInteger(year)) return false;
  return holidaysOf(year).has(date);
}
