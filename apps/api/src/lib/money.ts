/**
 * Japanese consumption tax helpers. Amounts are integer JPY.
 * - Prices are tax-inclusive (内税) by default, as is standard for salon price display (総額表示).
 * - Tax is computed per tax rate on the transaction total (インボイス制度: 税率ごとに1回端数処理), rounding down.
 */
export type RoundingMode = 'floor' | 'round' | 'ceil';

export function roundYen(v: number, mode: RoundingMode = 'floor'): number {
  // guard floating error (e.g. 1100 * 10/110 = 99.99999)
  const x = Math.round(v * 1e6) / 1e6;
  return mode === 'floor' ? Math.floor(x) : mode === 'ceil' ? Math.ceil(x) : Math.round(x);
}

/** tax included in a tax-inclusive amount. rateBp: 1000 = 10% */
export function includedTax(amountInclusive: number, rateBp: number, mode: RoundingMode = 'floor'): number {
  if (rateBp === 0) return 0;
  return roundYen((amountInclusive * rateBp) / (10000 + rateBp), mode);
}

/** convert a tax-exclusive price to inclusive */
export function toInclusive(amountExclusive: number, rateBp: number, mode: RoundingMode = 'floor'): number {
  return amountExclusive + roundYen((amountExclusive * rateBp) / 10000, mode);
}

export function percentOf(amount: number, percent: number, mode: RoundingMode = 'floor'): number {
  return roundYen((amount * percent) / 100, mode);
}

/**
 * Allocate an integer total across weights so the parts sum exactly to total (largest remainder method).
 * Used for: distributing discounts across lines, tax across lines, sales across staff.
 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum === 0) {
    const base = Math.trunc(total / weights.length);
    const parts = weights.map(() => base);
    let rest = total - base * weights.length;
    for (let i = 0; rest !== 0; i = (i + 1) % parts.length) {
      parts[i]! += Math.sign(rest);
      rest -= Math.sign(rest);
    }
    return parts;
  }
  const raw = weights.map((w) => (total * w) / sum);
  const parts = raw.map((r) => Math.trunc(r));
  let rest = total - parts.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: Math.abs(r - Math.trunc(r)) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest !== 0 && order.length > 0; k = (k + 1) % order.length) {
    parts[order[k]!.i]! += Math.sign(rest);
    rest -= Math.sign(rest);
  }
  return parts;
}
