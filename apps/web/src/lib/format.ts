import { DEFAULT_TZ, diffDays, todayIn, weekdayOf, zonedParts } from './time';

export const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'] as const;

const yenFormatter = new Intl.NumberFormat('ja-JP');

/** ¥12,000 (null/undefined → '—') */
export function formatYen(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}¥${yenFormatter.format(Math.abs(Math.round(n)))}`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return yenFormatter.format(n);
}

/** 2026/10/01(木) */
export function formatDate(
  instantOrDate: string | Date | null | undefined,
  tz = DEFAULT_TZ,
  opts: { weekday?: boolean; year?: boolean } = {},
): string {
  if (!instantOrDate) return '—';
  const { weekday = true, year = true } = opts;
  let y: number, m: number, d: number, wd: number;
  if (typeof instantOrDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(instantOrDate)) {
    [y, m, d] = instantOrDate.split('-').map(Number) as [number, number, number];
    wd = weekdayOf(instantOrDate);
  } else {
    const p = zonedParts(instantOrDate, tz);
    y = p.year;
    m = p.month;
    d = p.day;
    wd = p.weekday;
  }
  const base = `${year ? `${y}/` : ''}${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
  return weekday ? `${base}(${WEEKDAYS_JA[wd]})` : base;
}

/** 10月1日(木) */
export function formatDateJa(
  date: string,
  opts: { weekday?: boolean; year?: boolean } = {},
): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wd = opts.weekday === false ? '' : `(${WEEKDAYS_JA[weekdayOf(date)]})`;
  return `${opts.year ? `${y}年` : ''}${m}月${d}日${wd}`;
}

/** 14:30 */
export function formatTime(instant: string | Date | null | undefined, tz = DEFAULT_TZ): string {
  if (!instant) return '—';
  return zonedParts(instant, tz).time;
}

/** 2026/10/01(木) 14:30 */
export function formatDateTime(instant: string | Date | null | undefined, tz = DEFAULT_TZ): string {
  if (!instant) return '—';
  return `${formatDate(instant, tz)} ${formatTime(instant, tz)}`;
}

export function formatTimeRange(start: string, end: string, tz = DEFAULT_TZ): string {
  return `${formatTime(start, tz)}〜${formatTime(end, tz)}`;
}

/** 90 → 1時間30分 */
export function formatDuration(min: number | null | undefined): string {
  if (min === null || min === undefined) return '—';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h}時間${m}分`;
  if (h) return `${h}時間`;
  return `${m}分`;
}

/** 今日 / 明日 / 3日後 / 昨日 / 12日前 (calendar days in tz) */
export function formatRelativeDay(
  instantOrDate: string | Date | null | undefined,
  tz = DEFAULT_TZ,
  now: Date = new Date(),
): string {
  if (!instantOrDate) return '—';
  const date =
    typeof instantOrDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(instantOrDate)
      ? instantOrDate
      : zonedParts(instantOrDate, tz).date;
  const diff = diffDays(date, todayIn(tz, now));
  if (diff === 0) return '今日';
  if (diff === 1) return '明日';
  if (diff === 2) return '明後日';
  if (diff === -1) return '昨日';
  if (diff > 0) return diff >= 60 ? `${Math.round(diff / 30)}ヶ月後` : `${diff}日後`;
  const past = -diff;
  if (past >= 365) return `${Math.floor(past / 365)}年前`;
  if (past >= 60) return `${Math.round(past / 30)}ヶ月前`;
  return `${past}日前`;
}

/** "3分前" style for timestamps (history, memos) */
export function formatAgo(
  instant: string | Date | null | undefined,
  now: Date = new Date(),
): string {
  if (!instant) return '—';
  const t = typeof instant === 'string' ? new Date(instant) : instant;
  const sec = Math.round((now.getTime() - t.getTime()) / 1000);
  if (sec < 60) return 'たった今';
  if (sec < 3600) return `${Math.floor(sec / 60)}分前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間前`;
  return formatRelativeDay(t, DEFAULT_TZ, now);
}

export function formatAge(birthday: string | null | undefined, tz = DEFAULT_TZ): string | null {
  if (!birthday) return null;
  const today = todayIn(tz);
  const [by, bm, bd] = birthday.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age--;
  return `${age}歳`;
}

export const GENDER_LABEL: Record<string, string> = {
  female: '女性',
  male: '男性',
  other: 'その他',
  unknown: '未回答',
};

export function taxRateLabel(bp: number): string {
  return `${bp / 100}%`;
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const trimmed = name.replace(/\s+/g, '');
  return trimmed.slice(0, 1);
}
