import { allocate, includedTax, roundYen, type RoundingMode } from '../../lib/money.js';

/**
 * Pure POS arithmetic (税込/内税). All amounts are integer JPY.
 *
 *  1. positive lines: gross = unitPrice × qty, line discount (yen and/or %), amount = gross − lineDiscount
 *  2. transaction-level discounts / coupons / negative adjustments are applied in order against the
 *     current net of their eligible lines and allocated across them proportionally (allocate())
 *  3. tax is computed ONCE PER TAX RATE on the discounted tax-inclusive totals with the shop rounding
 *     mode (インボイス制度: 税率ごとに1回端数処理) and allocated back to the lines
 */
export interface CalcLine {
  idx: number;
  quantity: number;
  /** tax-inclusive unit price (>= 0) */
  unitPrice: number;
  lineDiscount?: number;
  lineDiscountPercent?: number;
  taxRateBp: number;
}

export interface CalcDiscount {
  idx: number;
  kind: 'amount' | 'percent';
  value: number;
  /** idx of positive lines this discount applies to (default: all) */
  eligible?: number[];
}

export interface CalcLineResult {
  idx: number;
  gross: number;
  lineDiscount: number;
  /** gross − lineDiscount (stored as transaction_items.amount) */
  amount: number;
  allocatedDiscount: number;
  /** amount − allocatedDiscount: basis for tax and staff sales allocation */
  net: number;
  taxAmount: number;
}

export interface CalcDiscountResult {
  idx: number;
  /** applied discount as a positive number (the line stores −amount) */
  amount: number;
}

export interface TaxBucket {
  taxable: number;
  tax: number;
}

export interface CalcResult {
  lines: CalcLineResult[];
  discounts: CalcDiscountResult[];
  subtotal: number;
  discountTotal: number;
  total: number;
  taxTotal: number;
  /** keyed by tax rate in basis points ("1000" = 10%, "800" = 8%) */
  taxBreakdown: Record<string, TaxBucket>;
}

export function calculate(lines: CalcLine[], discounts: CalcDiscount[], mode: RoundingMode = 'floor'): CalcResult {
  const res: CalcLineResult[] = lines.map((l) => {
    if (l.unitPrice < 0 || !Number.isInteger(l.unitPrice)) throw new RangeError('unitPrice must be a non-negative integer');
    const gross = l.unitPrice * l.quantity;
    const pct = l.lineDiscountPercent ? roundYen((gross * l.lineDiscountPercent) / 100, 'floor') : 0;
    const lineDiscount = Math.min(gross, (l.lineDiscount ?? 0) + pct);
    const amount = gross - lineDiscount;
    return { idx: l.idx, gross, lineDiscount, amount, allocatedDiscount: 0, net: amount, taxAmount: 0 };
  });
  const byIdx = new Map(res.map((r) => [r.idx, r]));

  const discountResults: CalcDiscountResult[] = [];
  for (const d of discounts) {
    const targets = (d.eligible ? d.eligible.map((i) => byIdx.get(i)).filter((x): x is CalcLineResult => !!x) : res).filter((t) => t.net > 0);
    const base = targets.reduce((s, t) => s + t.net, 0);
    let amount = d.kind === 'amount' ? d.value : roundYen((base * d.value) / 100, 'floor');
    amount = Math.max(0, Math.min(amount, base));
    if (amount > 0) {
      const parts = allocate(amount, targets.map((t) => t.net));
      targets.forEach((t, i) => {
        t.allocatedDiscount += parts[i]!;
        t.net -= parts[i]!;
      });
    }
    discountResults.push({ idx: d.idx, amount });
  }

  // tax per rate on the discounted inclusive totals, then allocated back to lines
  const taxBreakdown: Record<string, TaxBucket> = {};
  const rates = [...new Set(lines.map((l) => l.taxRateBp))].sort((a, b) => b - a);
  for (const rate of rates) {
    const group = lines.map((l, i) => ({ l, r: res[i]! })).filter((x) => x.l.taxRateBp === rate);
    const taxable = group.reduce((s, x) => s + x.r.net, 0);
    const tax = includedTax(taxable, rate, mode);
    const parts = allocate(tax, group.map((x) => x.r.net));
    group.forEach((x, i) => (x.r.taxAmount = parts[i]!));
    if (taxable !== 0 || group.length) taxBreakdown[String(rate)] = { taxable, tax };
  }

  const subtotal = res.reduce((s, r) => s + r.gross, 0);
  const total = res.reduce((s, r) => s + r.net, 0);
  const taxTotal = Object.values(taxBreakdown).reduce((s, b) => s + b.tax, 0);
  return { lines: res, discounts: discountResults, subtotal, discountTotal: subtotal - total, total, taxTotal, taxBreakdown };
}

export interface StaffShare {
  staffId: string;
  shareBp: number;
  role: 'main' | 'assistant' | 'referral';
  isNominated: boolean;
}

/** Split a line's net amount across staff by share (exact sum) */
export function allocateStaff(net: number, shares: StaffShare[]): (StaffShare & { allocatedAmount: number })[] {
  if (!shares.length) return [];
  const parts = allocate(net, shares.map((s) => s.shareBp));
  return shares.map((s, i) => ({ ...s, allocatedAmount: parts[i]! }));
}

/** Points earned for a paid amount (floor) */
export function pointsFor(amount: number, rateBp: number): number {
  if (amount <= 0 || rateBp <= 0) return 0;
  return Math.floor((amount * rateBp) / 10000);
}
