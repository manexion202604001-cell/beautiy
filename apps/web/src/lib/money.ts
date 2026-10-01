/**
 * Money / tax display helpers for POS, EC and receipts (all amounts are integer JPY, tax-inclusive).
 * The API is the source of truth for totals; these helpers only format and pre-compute UI hints
 * (change, denomination counting, staff share splits).
 */

/** "1000" (basis points) → "10%" / "8%（軽減）" */
export function taxRateText(rateBp: number | string, opts: { reducedMark?: boolean } = {}): string {
  const bp = typeof rateBp === 'string' ? Number(rateBp) : rateBp;
  if (!Number.isFinite(bp)) return '—';
  const pct = `${bp / 100}%`;
  if (bp === 0) return '非課税';
  return bp === 800 && opts.reducedMark !== false ? `${pct}（軽減）` : pct;
}

export interface TaxBucket {
  taxable: number;
  tax: number;
}

export interface TaxRow {
  rateBp: number;
  label: string;
  /** tax-inclusive amount subject to the rate */
  taxable: number;
  tax: number;
  /** taxable − tax */
  net: number;
}

/**
 * API tax_breakdown ({ "1000": { taxable, tax } }) → sorted display rows (higher rate first,
 * zero-amount buckets dropped).
 */
export function taxBreakdownRows(
  breakdown: Record<string, TaxBucket> | null | undefined,
): TaxRow[] {
  if (!breakdown) return [];
  return Object.entries(breakdown)
    .map(([rate, b]) => ({
      rateBp: Number(rate),
      label: `${taxRateText(Number(rate))}対象`,
      taxable: b.taxable,
      tax: b.tax,
      net: b.taxable - b.tax,
    }))
    .filter((r) => Number.isFinite(r.rateBp) && (r.taxable !== 0 || r.tax !== 0))
    .sort((a, b) => b.rateBp - a.rateBp);
}

/** Consumption tax included in a tax-inclusive amount (rounded down, display estimate only) */
export function includedTax(amount: number, rateBp: number): number {
  if (rateBp <= 0) return 0;
  return Math.floor((amount * rateBp) / (10000 + rateBp));
}

/** Tax-inclusive price from a price that may be tax-exclusive (rounded down like the API default) */
export function inclusivePrice(price: number, taxIncluded: boolean, rateBp: number): number {
  return taxIncluded ? price : Math.floor((price * (10000 + rateBp)) / 10000);
}

/** Change for a cash payment (never negative) */
export function changeFor(tendered: number, due: number): number {
  if (!Number.isFinite(tendered) || !Number.isFinite(due)) return 0;
  return Math.max(0, Math.round(tendered) - Math.max(0, Math.round(due)));
}

/** Amount applied from a cash tender to the outstanding balance */
export function appliedCash(tendered: number, outstanding: number): number {
  return Math.max(0, Math.min(Math.round(tendered), Math.max(0, outstanding)));
}

/** Japanese yen denominations used for register counting (金種) */
export const DENOMINATIONS = [10000, 5000, 2000, 1000, 500, 100, 50, 10, 5, 1] as const;

export function denominationLabel(d: number): string {
  return d >= 1000 ? `${d.toLocaleString('ja-JP')}円札` : `${d}円玉`;
}

/** { "10000": 3, "1000": 5 } → 35000 (ignores invalid keys / counts) */
export function sumDenominations(counts: Record<string, number | string | undefined>): number {
  let total = 0;
  for (const [k, v] of Object.entries(counts)) {
    const d = Number(k);
    const n = typeof v === 'string' ? Number(v) : (v ?? 0);
    if (!Number.isInteger(d) || d <= 0 || !Number.isFinite(n) || n <= 0) continue;
    total += d * Math.floor(n);
  }
  return total;
}

/** Drop empty counts and normalize to integers for the API cashBreakdown payload */
export function cleanBreakdown(
  counts: Record<string, number | string | undefined>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) {
    const n = typeof v === 'string' ? Number(v) : (v ?? 0);
    if (/^\d+$/.test(k) && Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
  }
  return out;
}

/** Quick-tender suggestions for the cash keypad (exact + next round bills) */
export function tenderSuggestions(due: number): number[] {
  if (due <= 0) return [];
  const out = new Set<number>([due]);
  for (const unit of [1000, 5000, 10000]) {
    const up = Math.ceil(due / unit) * unit;
    if (up > due) out.add(up);
  }
  return [...out].sort((a, b) => a - b).slice(0, 4);
}

/** Split 100% (10000bp) evenly across n people; remainders go to the first entries */
export function evenShares(n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(10000 / n);
  const rest = 10000 - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

/** bp (0–10000) → "33.33" percent text without trailing zeros */
export function bpToPercentText(bp: number): string {
  return String(Math.round(bp) / 100);
}

/** percent text ("33.3") → bp (rounded) or null when invalid */
export function percentTextToBp(text: string): number | null {
  if (text.trim() === '') return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100);
}

/** Parse a yen input ("1,200" / "１２００" / "¥1200") → integer or null */
export function parseYen(text: string): number | null {
  const normalized = text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[¥￥,\s円]/g, '');
  if (normalized === '' || !/^-?\d+$/.test(normalized)) return null;
  return Number(normalized);
}
