import { describe, expect, it } from 'vitest';
import { allocateStaff, calculate, pointsFor } from './calc.js';

describe('POS calculation (内税・税率別端数処理)', () => {
  const mixed = () =>
    calculate(
      [
        { idx: 0, quantity: 1, unitPrice: 5500, taxRateBp: 1000 }, // 施術 10%
        { idx: 1, quantity: 2, unitPrice: 1080, taxRateBp: 800 }, // 軽減税率 8%
      ],
      [{ idx: 2, kind: 'amount', value: 1000 }],
      'floor',
    );

  it('allocates transaction discounts proportionally and computes tax once per rate', () => {
    const r = mixed();
    expect(r.subtotal).toBe(7660);
    expect(r.discountTotal).toBe(1000);
    expect(r.total).toBe(6660);
    // 1000 × 5500/7660 = 718.02, 1000 × 2160/7660 = 281.98 → largest remainder: 718 / 282
    expect(r.lines.map((l) => l.allocatedDiscount)).toEqual([718, 282]);
    expect(r.lines.map((l) => l.net)).toEqual([4782, 1878]);
    // 10%: 4782 × 10/110 = 434.72 / 8%: 1878 × 8/108 = 139.11
    expect(r.taxBreakdown).toEqual({ '1000': { taxable: 4782, tax: 434 }, '800': { taxable: 1878, tax: 139 } });
    expect(r.taxTotal).toBe(573);
    expect(r.lines.reduce((s, l) => s + l.taxAmount, 0)).toBe(r.taxTotal);
    expect(r.discounts).toEqual([{ idx: 2, amount: 1000 }]);
  });

  it('honours the shop rounding mode', () => {
    const lines = [
      { idx: 0, quantity: 1, unitPrice: 5500, taxRateBp: 1000 },
      { idx: 1, quantity: 2, unitPrice: 1080, taxRateBp: 800 },
    ];
    const d = [{ idx: 2, kind: 'amount' as const, value: 1000 }];
    expect(calculate(lines, d, 'round').taxBreakdown).toEqual({ '1000': { taxable: 4782, tax: 435 }, '800': { taxable: 1878, tax: 139 } });
    expect(calculate(lines, d, 'ceil').taxBreakdown).toEqual({ '1000': { taxable: 4782, tax: 435 }, '800': { taxable: 1878, tax: 140 } });
  });

  it('rounds per tax rate (not per line) and allocates the tax back to lines exactly', () => {
    // per line: 105 × 10/110 = 9.54 → 9 ×3 = 27, per rate: 315 × 10/110 = 28.63 → 28
    const r = calculate(
      [0, 1, 2].map((idx) => ({ idx, quantity: 1, unitPrice: 105, taxRateBp: 1000 })),
      [],
      'floor',
    );
    expect(r.taxTotal).toBe(28);
    expect(r.lines.map((l) => l.taxAmount).sort()).toEqual([10, 9, 9].sort());
  });

  it('applies line discounts, percent discounts and coupon eligibility in order', () => {
    const r = calculate(
      [
        { idx: 0, quantity: 1, unitPrice: 8800, taxRateBp: 1000, lineDiscountPercent: 10 }, // 8800 - 880
        { idx: 1, quantity: 3, unitPrice: 2200, taxRateBp: 1000, lineDiscount: 200 }, // 6600 - 200
        { idx: 2, quantity: 1, unitPrice: 1620, taxRateBp: 800 },
      ],
      [
        { idx: 3, kind: 'amount', value: 1000, eligible: [0] }, // coupon only for the service
        { idx: 4, kind: 'percent', value: 10 }, // then 10% off everything
      ],
      'floor',
    );
    expect(r.lines.map((l) => [l.gross, l.lineDiscount, l.amount])).toEqual([
      [8800, 880, 7920],
      [6600, 200, 6400],
      [1620, 0, 1620],
    ]);
    // coupon: 7920 → 6920; percent base 6920+6400+1620 = 14940 → 1494
    expect(r.discounts).toEqual([
      { idx: 3, amount: 1000 },
      { idx: 4, amount: 1494 },
    ]);
    expect(r.total).toBe(14940 - 1494);
    expect(r.subtotal - r.discountTotal).toBe(r.total);
    expect(r.lines.reduce((s, l) => s + l.net, 0)).toBe(r.total);
  });

  it('never discounts below zero', () => {
    const r = calculate([{ idx: 0, quantity: 1, unitPrice: 500, taxRateBp: 1000 }], [{ idx: 1, kind: 'amount', value: 2000 }]);
    expect(r.total).toBe(0);
    expect(r.discounts[0]!.amount).toBe(500);
    expect(r.taxTotal).toBe(0);
  });

  it('splits staff sales exactly', () => {
    const parts = allocateStaff(10001, [
      { staffId: 'a', shareBp: 3333, role: 'main', isNominated: true },
      { staffId: 'b', shareBp: 3333, role: 'assistant', isNominated: false },
      { staffId: 'c', shareBp: 3334, role: 'assistant', isNominated: false },
    ]);
    expect(parts.reduce((s, p) => s + p.allocatedAmount, 0)).toBe(10001);
    expect(parts.map((p) => p.allocatedAmount)).toEqual([3333, 3333, 3335]);
  });

  it('computes earned points with floor', () => {
    expect(pointsFor(12399, 100)).toBe(123);
    expect(pointsFor(99, 100)).toBe(0);
    expect(pointsFor(1000, 0)).toBe(0);
  });
});
