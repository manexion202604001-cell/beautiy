/**
 * Japanese public holiday detection utility.
 * Supports: fixed holidays, Happy Monday holidays, equinoxes, substitute holidays, and citizens' holidays.
 */

const FIXED_HOLIDAYS: [number, number][] = [
  [1, 1], [2, 11], [2, 23], [4, 29], [5, 3], [5, 4], [5, 5], [8, 11], [11, 3], [11, 23],
];

const HAPPY_MONDAY_HOLIDAYS: [number, number][] = [
  [1, 2], [7, 3], [9, 3], [10, 2],
];

function getNthWeekday(year: number, month: number, weekday: number, n: number): number {
  const firstDay = new Date(year, month - 1, 1).getDay();
  let day = 1 + ((weekday - firstDay + 7) % 7);
  day += (n - 1) * 7;
  return day;
}

function getVernalEquinoxDay(year: number): number {
  if (year >= 2000 && year <= 2099) return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  if (year >= 2100 && year <= 2150) return Math.floor(21.8510 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  return 21;
}

function getAutumnalEquinoxDay(year: number): number {
  if (year >= 2000 && year <= 2099) return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  if (year >= 2100 && year <= 2150) return Math.floor(24.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  return 23;
}

function getHolidaysForYear(year: number): Set<string> {
  const holidays = new Map<string, string>();
  const key = (m: number, d: number) => `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  for (const [month, day] of FIXED_HOLIDAYS) holidays.set(key(month, day), '');
  for (const [month, n] of HAPPY_MONDAY_HOLIDAYS) holidays.set(key(month, getNthWeekday(year, month, 1, n)), '');
  holidays.set(key(3, getVernalEquinoxDay(year)), '');
  holidays.set(key(9, getAutumnalEquinoxDay(year)), '');

  const sortedDates = [...holidays.keys()].sort();
  for (const dateStr of sortedDates) {
    const d = new Date(dateStr + 'T00:00:00');
    if (d.getDay() === 0) {
      const substitute = new Date(d);
      substitute.setDate(substitute.getDate() + 1);
      while (holidays.has(substitute.toISOString().slice(0, 10))) substitute.setDate(substitute.getDate() + 1);
      holidays.set(substitute.toISOString().slice(0, 10), '');
    }
  }

  const allDates = [...holidays.keys()].sort();
  for (let i = 0; i < allDates.length - 1; i++) {
    const d1 = new Date(allDates[i] + 'T00:00:00');
    const d2 = new Date(allDates[i + 1] + 'T00:00:00');
    if ((d2.getTime() - d1.getTime()) / 86400000 === 2) {
      const between = new Date(d1);
      between.setDate(between.getDate() + 1);
      const betweenStr = between.toISOString().slice(0, 10);
      if (!holidays.has(betweenStr) && between.getDay() !== 0) holidays.set(betweenStr, '');
    }
  }

  return new Set(holidays.keys());
}

const cache = new Map<number, Set<string>>();

export function isJapaneseHoliday(dateStr: string): boolean {
  const year = parseInt(dateStr.slice(0, 4));
  if (!cache.has(year)) cache.set(year, getHolidaysForYear(year));
  return cache.get(year)!.has(dateStr);
}
