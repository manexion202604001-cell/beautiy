/** RFC 4180 CSV with UTF-8 BOM (Excel friendly for Japanese) and formula-injection protection */
export function toCsv(headers: { key: string; label: string }[], rows: Record<string, unknown>[], bom = true): string {
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    // CSV injection: prefix cells starting with = + - @ (except plain negative numbers)
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map((h) => escape(h.label)).join(',')];
  for (const row of rows) lines.push(headers.map((h) => escape(row[h.key])).join(','));
  return (bom ? '﻿' : '') + lines.join('\r\n') + '\r\n';
}
