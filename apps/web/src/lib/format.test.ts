import { describe, expect, it } from 'vitest';
import {
  formatAge,
  formatDate,
  formatDateTime,
  formatDuration,
  formatRelativeDay,
  formatTime,
  formatYen,
} from './format';
import {
  addDays,
  addMonths,
  dateRange,
  hhmmToMinutes,
  minutesToHhmm,
  startOfWeek,
  todayIn,
  weekdayOf,
  zonedParts,
  zonedToIso,
} from './time';

describe('formatYen', () => {
  it('formats integers with yen sign and separators', () => {
    expect(formatYen(12000)).toBe('¥12,000');
    expect(formatYen(0)).toBe('¥0');
    expect(formatYen(-550)).toBe('-¥550');
    expect(formatYen(null)).toBe('—');
  });
});

describe('JST formatting', () => {
  // 2026-10-01T05:30:00Z = 2026-10-01 14:30 JST (Thursday)
  const iso = '2026-10-01T05:30:00.000Z';
  it('formats date/time in Asia/Tokyo regardless of host timezone', () => {
    expect(formatDate(iso)).toBe('2026/10/01(木)');
    expect(formatTime(iso)).toBe('14:30');
    expect(formatDateTime(iso)).toBe('2026/10/01(木) 14:30');
    expect(formatDate('2026-10-04', undefined, { year: false })).toBe('10/04(日)');
  });

  it('handles the JST date boundary (UTC previous day)', () => {
    expect(formatDate('2026-09-30T15:30:00.000Z')).toBe('2026/10/01(木)');
    expect(formatTime('2026-09-30T15:30:00.000Z')).toBe('00:30');
  });

  it('formats durations', () => {
    expect(formatDuration(90)).toBe('1時間30分');
    expect(formatDuration(60)).toBe('1時間');
    expect(formatDuration(15)).toBe('15分');
  });

  it('formats relative calendar days', () => {
    const now = new Date('2026-10-01T03:00:00Z'); // 12:00 JST
    expect(formatRelativeDay('2026-10-01', undefined, now)).toBe('今日');
    expect(formatRelativeDay('2026-10-02', undefined, now)).toBe('明日');
    expect(formatRelativeDay('2026-09-30', undefined, now)).toBe('昨日');
    expect(formatRelativeDay('2026-10-08', undefined, now)).toBe('7日後');
    expect(formatRelativeDay('2026-07-01', undefined, now)).toBe('3ヶ月前');
  });

  it('computes age', () => {
    expect(formatAge('1990-04-12')).toMatch(/^\d+歳$/);
  });
});

describe('time helpers', () => {
  it('converts zoned local time to UTC ISO and back', () => {
    expect(zonedToIso('2026-10-01', '10:00', 'Asia/Tokyo')).toBe('2026-10-01T01:00:00.000Z');
    expect(zonedToIso('2026-03-08', '10:00', 'America/New_York')).toBe('2026-03-08T14:00:00.000Z'); // DST start day
    const p = zonedParts('2026-10-01T01:00:00.000Z', 'Asia/Tokyo');
    expect(p).toMatchObject({ date: '2026-10-01', time: '10:00', minutes: 600, weekday: 4 });
  });

  it('does date arithmetic on plain strings', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(weekdayOf('2026-10-04')).toBe(0);
    expect(startOfWeek('2026-10-04')).toBe('2026-09-28');
    expect(dateRange('2026-10-01', '2026-10-03')).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
    expect(minutesToHhmm(615)).toBe('10:15');
    expect(hhmmToMinutes('19:45')).toBe(1185);
  });

  it('todayIn respects the timezone', () => {
    const now = new Date('2026-09-30T20:00:00Z');
    expect(todayIn('Asia/Tokyo', now)).toBe('2026-10-01');
    expect(todayIn('UTC', now)).toBe('2026-09-30');
  });
});
