// POS money rules. All amounts are integer JPY and tax-inclusive (内税).

export interface TicketLine { kind: 'SERVICE' | 'RETAIL' | 'OTHER'; name: string; unitPrice: number; quantity: number; discount?: number }
export interface CouponRule { discountType: 'AMOUNT' | 'PERCENT'; discountValue: number }

export interface TicketInput {
  lines: TicketLine[];
  coupon?: CouponRule | null;
  /** Manual whole-ticket discount (yen). */
  manualDiscount?: number;
  pointsToUse?: number;
  pointsBalance?: number;
  taxRatePct: number;
  pointRatePct: number;
}

export interface TicketTotals {
  subtotal: number;
  lineDiscounts: number;
  couponDiscount: number;
  manualDiscount: number;
  discountTotal: number;
  pointsUsed: number;
  total: number;
  taxTotal: number;
  pointsEarned: number;
  serviceTotal: number;
  retailTotal: number;
}

const int = (n: number) => Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));

export function lineAmount(l: TicketLine): number {
  return Math.max(0, int(l.unitPrice) * Math.max(1, int(l.quantity)) - int(l.discount ?? 0));
}

export function computeTicket(input: TicketInput): TicketTotals {
  let subtotal = 0, lineDiscounts = 0, serviceGross = 0, retailGross = 0;
  for (const l of input.lines) {
    const gross = int(l.unitPrice) * Math.max(1, int(l.quantity));
    const disc = Math.min(gross, int(l.discount ?? 0));
    subtotal += gross;
    lineDiscounts += disc;
    if (l.kind === 'RETAIL') retailGross += gross - disc; else serviceGross += gross - disc;
  }
  const afterLines = subtotal - lineDiscounts;
  let couponDiscount = 0;
  if (input.coupon) {
    couponDiscount = input.coupon.discountType === 'PERCENT'
      ? Math.floor((afterLines * Math.min(100, int(input.coupon.discountValue))) / 100)
      : int(input.coupon.discountValue);
    couponDiscount = Math.min(couponDiscount, afterLines);
  }
  const manualDiscount = Math.min(int(input.manualDiscount ?? 0), afterLines - couponDiscount);
  const discountTotal = lineDiscounts + couponDiscount + manualDiscount;
  const afterDiscount = subtotal - discountTotal;
  const pointsUsed = Math.min(int(input.pointsToUse ?? 0), int(input.pointsBalance ?? 0), afterDiscount);
  const total = afterDiscount - pointsUsed;
  const rate = int(input.taxRatePct);
  const taxTotal = Math.floor((total * rate) / (100 + rate));
  const pointsEarned = Math.floor((total * int(input.pointRatePct)) / 100);
  // distribute ticket-level discounts proportionally for service/retail split
  const gross = serviceGross + retailGross;
  const ratio = gross > 0 ? total / gross : 0;
  const retailTotal = Math.round(retailGross * ratio);
  return {
    subtotal, lineDiscounts, couponDiscount, manualDiscount, discountTotal, pointsUsed, total, taxTotal, pointsEarned,
    serviceTotal: total - retailTotal, retailTotal,
  };
}

export interface TenderInput { method: string; amount: number }
export interface Settlement { ok: boolean; paid: number; change: number; remaining: number; error?: string }

/**
 * Validate split tender. Only CASH may exceed the amount due (change is returned);
 * card/e-money/etc must never over-collect.
 */
export function settle(total: number, tenders: TenderInput[]): Settlement {
  const clean = tenders.filter((t) => int(t.amount) > 0);
  const nonCash = clean.filter((t) => t.method !== 'CASH').reduce((s, t) => s + int(t.amount), 0);
  const cash = clean.filter((t) => t.method === 'CASH').reduce((s, t) => s + int(t.amount), 0);
  const paid = nonCash + cash;
  if (nonCash > total) return { ok: false, paid, change: 0, remaining: 0, error: 'キャッシュレス決済額が請求額を超えています' };
  const change = Math.max(0, paid - total);
  const remaining = Math.max(0, total - paid);
  if (remaining > 0) return { ok: false, paid, change: 0, remaining, error: `未収 ¥${remaining.toLocaleString()}` };
  return { ok: true, paid, change, remaining: 0 };
}

export function validateRefund(total: number, alreadyRefunded: number, amount: number): string | null {
  if (!Number.isInteger(amount) || amount <= 0) return '返金額が不正です';
  if (alreadyRefunded + amount > total) return '返金可能額を超えています';
  return null;
}

export interface RegisterSummaryInput { openingCash: number; cashSales: number; cashRefunds: number; cashInOut?: number }
export function expectedCash(i: RegisterSummaryInput): number {
  return int(i.openingCash) + int(i.cashSales) - int(i.cashRefunds) + Math.floor(i.cashInOut ?? 0);
}

export function yen(n: number): string {
  return `¥${Math.round(n).toLocaleString('ja-JP')}`;
}
