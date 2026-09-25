// Client-safe formatting helpers (Japanese locale).
import { jaWeekday, minutesToHHMM, toLocalParts } from '@salonos/core';

export const TZ_DEFAULT = 'Asia/Tokyo';

export function yen(n: number | null | undefined): string {
  return `¥${Math.round(n ?? 0).toLocaleString('ja-JP')}`;
}

export function yenShort(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `¥${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 10_000) return `¥${(n / 1000).toFixed(0)}K`;
  return yen(n);
}

export function fmtDate(d: Date | string | number | null | undefined, tz = TZ_DEFAULT): string {
  if (d === null || d === undefined) return '—';
  const p = toLocalParts(new Date(d), tz);
  return `${p.year}/${String(p.month).padStart(2, '0')}/${String(p.day).padStart(2, '0')}`;
}

export function fmtDateW(d: Date | string | number, tz = TZ_DEFAULT): string {
  const p = toLocalParts(new Date(d), tz);
  return `${p.month}/${p.day}(${jaWeekday(p.weekday)})`;
}

export function fmtTime(d: Date | string | number, tz = TZ_DEFAULT): string {
  return minutesToHHMM(toLocalParts(new Date(d), tz).minutes);
}

export function fmtDateTime(d: Date | string | number | null | undefined, tz = TZ_DEFAULT): string {
  if (d === null || d === undefined) return '—';
  return `${fmtDate(d, tz)} ${fmtTime(d, tz)}`;
}

export function fmtRange(start: Date | string, end: Date | string, tz = TZ_DEFAULT): string {
  return `${fmtTime(start, tz)}–${fmtTime(end, tz)}`;
}

export function daysSince(d: Date | string | null | undefined, now = Date.now()): number | null {
  if (!d) return null;
  return Math.floor((now - new Date(d).getTime()) / 86400000);
}

export function initials(name: string): string {
  return (name || '?').trim().slice(0, 1);
}

export function pct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}
