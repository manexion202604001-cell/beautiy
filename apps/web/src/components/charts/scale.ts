/** Small scale / formatting helpers for the in-house SVG charts (no chart dependency). */

export const SERIES_COLORS = [
  'var(--viz-1)',
  'var(--viz-2)',
  'var(--viz-3)',
  'var(--viz-4)',
  'var(--viz-5)',
  'var(--viz-6)',
] as const;

/** Fixed-order categorical color; index ≥ 6 folds into "other" gray (never generate hues) */
export function seriesColor(i: number): string {
  return SERIES_COLORS[i] ?? 'var(--viz-other)';
}

/** Clean axis ticks (1/2/2.5/5 × 10^n) covering [min, max], always including 0 */
export function niceTicks(minValue: number, maxValue: number, count = 4, integer = false): number[] {
  const min = Math.min(0, minValue);
  const max = Math.max(0, maxValue);
  if (max === min) return [0, max === 0 ? 1 : max];
  const raw = (max - min) / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  // counts never get fractional ticks (0, 0.5, 1 … would print as duplicated labels)
  if (integer) step = Math.max(1, Math.ceil(step));
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** 12,345 → "1.2万" / 123,456,789 → "1.2億" (axis ticks, compact tiles) */
export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  const trim = (x: number) => (Math.round(x * 10) / 10).toLocaleString('ja-JP');
  if (abs >= 1e8) return `${trim(n / 1e8)}億`;
  if (abs >= 1e4) return `${trim(n / 1e4)}万`;
  return Math.round(n).toLocaleString('ja-JP');
}

export function compactYen(n: number): string {
  return `¥${compactNumber(n)}`;
}

export function formatPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

/** Signed delta text: +12.3% / −4.0% / — */
export function formatDelta(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n === 0) return '±0%';
  return `${n > 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`;
}

/** Show every k-th x label so labels keep ≥ minGap px apart */
export function labelStride(count: number, width: number, minGap = 56): number {
  if (count <= 1) return 1;
  const per = width / count;
  return Math.max(1, Math.ceil(minGap / per));
}

/** Indices that get an x label: every `stride`-th plus the last one when it does not crowd */
export function xLabelIndices(count: number, stride: number): Set<number> {
  const out = new Set<number>();
  let last = -1;
  for (let i = 0; i < count; i += stride) {
    out.add(i);
    last = i;
  }
  if (count > 1 && last !== count - 1 && count - 1 - last >= stride * 0.6) out.add(count - 1);
  return out;
}

/** "2026-09-14" → "9/14", "2026-09" → "9月", week keys stay as given */
export function shortPeriod(key: string): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(key);
  if (!m) return key;
  if (!m[3]) return `${Number(m[2])}月`;
  return `${Number(m[2])}/${Number(m[3])}`;
}
