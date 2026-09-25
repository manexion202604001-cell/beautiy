import { describe, expect, it } from 'vitest';
import { computeTicket, expectedCash, settle, validateRefund } from '../src/pricing';

describe('computeTicket', () => {
  const lines = [
    { kind: 'SERVICE' as const, name: 'カット', unitPrice: 5500, quantity: 1 },
    { kind: 'SERVICE' as const, name: 'カラー', unitPrice: 8800, quantity: 1, discount: 800 },
    { kind: 'RETAIL' as const, name: 'シャンプー', unitPrice: 3300, quantity: 2 },
  ];
  it('computes inclusive tax, discounts and points', () => {
    const t = computeTicket({ lines, taxRatePct: 10, pointRatePct: 1, coupon: { discountType: 'PERCENT', discountValue: 10 }, pointsToUse: 500, pointsBalance: 1000 });
    expect(t.subtotal).toBe(20900);
    expect(t.lineDiscounts).toBe(800);
    expect(t.couponDiscount).toBe(2010);
    expect(t.discountTotal).toBe(2810);
    expect(t.pointsUsed).toBe(500);
    expect(t.total).toBe(17590);
    expect(t.taxTotal).toBe(Math.floor(17590 * 10 / 110));
    expect(t.pointsEarned).toBe(175);
    expect(t.serviceTotal + t.retailTotal).toBe(t.total);
  });
  it('never lets points exceed balance or total', () => {
    const t = computeTicket({ lines: [{ kind: 'SERVICE', name: 'x', unitPrice: 1000, quantity: 1 }], taxRatePct: 10, pointRatePct: 1, pointsToUse: 5000, pointsBalance: 3000 });
    expect(t.pointsUsed).toBe(1000);
    expect(t.total).toBe(0);
  });
  it('caps amount coupons at the ticket value', () => {
    const t = computeTicket({ lines: [{ kind: 'SERVICE', name: 'x', unitPrice: 1000, quantity: 1 }], taxRatePct: 10, pointRatePct: 0, coupon: { discountType: 'AMOUNT', discountValue: 3000 } });
    expect(t.couponDiscount).toBe(1000);
    expect(t.total).toBe(0);
  });
});

describe('settle', () => {
  it('returns change only for cash', () => {
    expect(settle(17600, [{ method: 'CASH', amount: 20000 }])).toMatchObject({ ok: true, change: 2400 });
    expect(settle(17600, [{ method: 'CARD', amount: 20000 }]).ok).toBe(false);
  });
  it('supports split tender', () => {
    expect(settle(17600, [{ method: 'CARD', amount: 10000 }, { method: 'CASH', amount: 8000 }])).toMatchObject({ ok: true, change: 400 });
    expect(settle(17600, [{ method: 'CARD', amount: 10000 }])).toMatchObject({ ok: false, remaining: 7600 });
  });
});

describe('refund & register', () => {
  it('validates refund bounds', () => {
    expect(validateRefund(10000, 0, 10000)).toBeNull();
    expect(validateRefund(10000, 6000, 5000)).not.toBeNull();
    expect(validateRefund(10000, 0, 0)).not.toBeNull();
  });
  it('computes expected cash', () => {
    expect(expectedCash({ openingCash: 30000, cashSales: 52000, cashRefunds: 2000 })).toBe(80000);
  });
});
