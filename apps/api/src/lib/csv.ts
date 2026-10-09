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

/** RFC 4180 parser (quoted fields, escaped quotes, CRLF/LF, UTF-8 BOM); blank lines are dropped */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim()));
}
