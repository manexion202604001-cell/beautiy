/**
 * Japanese public holiday detection utility.
 * Supports: fixed holidays, Happy Monday holidays, equinoxes, substitute holidays, and citizens' holidays.
 */

// Fixed date holidays: [month, day, name]
const FIXED_HOLIDAYS: [number, number, string][] = [
  [1, 1, '元日'],
  [2, 11, '建国記念の日'],
  [2, 23, '天皇誕生日'],
  [4, 29, '昭和の日'],
  [5, 3, '憲法記念日'],
  [5, 4, 'みどりの日'],
  [5, 5, 'こどもの日'],
  [8, 11, '山の日'],
  [11, 3, '文化の日'],
  [11, 23, '勤労感謝の日'],
];

// Happy Monday holidays: [month, weekNumber (1-indexed), name]
// weekNumber = Nth Monday of the month
const HAPPY_MONDAY_HOLIDAYS: [number, number, string][] = [
  [1, 2, '成人の日'],     // January 2nd Monday
  [7, 3, '海の日'],       // July 3rd Monday
  [9, 3, '敬老の日'],     // September 3rd Monday
  [10, 2, 'スポーツの日'], // October 2nd Monday
];

/**
 * Calculate the Nth weekday of a given month.
 * @param year Year
 * @param month Month (1-12)
 * @param weekday Day of week (0=Sunday, 1=Monday, ...)
 * @param n Nth occurrence (1-indexed)
 */
function getNthWeekday(year: number, month: number, weekday: number, n: number): number {
  const firstDay = new Date(year, month - 1, 1).getDay();
  let day = 1 + ((weekday - firstDay + 7) % 7);
  day += (n - 1) * 7;
  return day;
}

/**
 * Approximate spring equinox day for a given year.
 * Based on the astronomical formula used by Japan's National Astronomical Observatory.
 */
function getVernalEquinoxDay(year: number): number {
  if (year >= 2000 && year <= 2099) {
    return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }
  if (year >= 2100 && year <= 2150) {
    return Math.floor(21.8510 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }
  // Fallback for other ranges
  return 21;
}

/**
 * Approximate autumnal equinox day for a given year.
 */
function getAutumnalEquinoxDay(year: number): number {
  if (year >= 2000 && year <= 2099) {
    return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }
  if (year >= 2100 && year <= 2150) {
    return Math.floor(24.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }
  return 23;
}

/**
 * Get all Japanese public holidays for a given year as a Set of "MM-DD" strings.
 */
function getHolidaysForYear(year: number): Set<string> {
  const holidays = new Map<string, string>(); // "YYYY-MM-DD" -> name

  const key = (m: number, d: number) =>
    `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  // Fixed holidays
  for (const [month, day] of FIXED_HOLIDAYS) {
    holidays.set(key(month, day), '');
  }

  // Happy Monday holidays
  for (const [month, n] of HAPPY_MONDAY_HOLIDAYS) {
    const day = getNthWeekday(year, month, 1, n); // 1 = Monday
    holidays.set(key(month, day), '');
  }

  // Equinoxes
  const vernalDay = getVernalEquinoxDay(year);
  holidays.set(key(3, vernalDay), '春分の日');

  const autumnalDay = getAutumnalEquinoxDay(year);
  holidays.set(key(9, autumnalDay), '秋分の日');

  // Substitute holidays (振替休日): if a holiday falls on Sunday, the next non-holiday weekday is a holiday
  const sortedDates = [...holidays.keys()].sort();
  for (const dateStr of sortedDates) {
    const d = new Date(dateStr + 'T00:00:00');
    if (d.getDay() === 0) { // Sunday
      let substitute = new Date(d);
      substitute.setDate(substitute.getDate() + 1);
      while (holidays.has(substitute.toISOString().slice(0, 10))) {
        substitute.setDate(substitute.getDate() + 1);
      }
      holidays.set(substitute.toISOString().slice(0, 10), '振替休日');
    }
  }

  // Citizens' holiday (国民の休日): a weekday sandwiched between two holidays
  const allDates = [...holidays.keys()].sort();
  for (let i = 0; i < allDates.length - 1; i++) {
    const d1 = new Date(allDates[i] + 'T00:00:00');
    const d2 = new Date(allDates[i + 1] + 'T00:00:00');
    const diff = (d2.getTime() - d1.getTime()) / (24 * 60 * 60 * 1000);
    if (diff === 2) {
      const between = new Date(d1);
      between.setDate(between.getDate() + 1);
      const betweenStr = between.toISOString().slice(0, 10);
      if (!holidays.has(betweenStr) && between.getDay() !== 0) {
        holidays.set(betweenStr, '国民の休日');
      }
    }
  }

  return new Set(holidays.keys());
}

// Cache holidays per year
const cache = new Map<number, Set<string>>();

/**
 * Check if a date string (YYYY-MM-DD) is a Japanese public holiday.
 */
export function isJapaneseHoliday(dateStr: string): boolean {
  const year = parseInt(dateStr.slice(0, 4));
  if (!cache.has(year)) {
    cache.set(year, getHolidaysForYear(year));
  }
  return cache.get(year)!.has(dateStr);
}
