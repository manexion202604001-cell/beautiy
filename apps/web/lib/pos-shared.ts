// Client-safe POS / commerce definitions shared by server services and UI components.
import { z } from 'zod';

export const PAYMENT_METHODS = ['CASH', 'CARD', 'EMONEY', 'QR', 'STRIPE', 'SQUARE', 'CUSTOM'] as const;
export type PaymentMethodName = (typeof PAYMENT_METHODS)[number];

export const METHOD_LABEL: Record<PaymentMethodName, string> = {
  CASH: '現金', CARD: 'クレジットカード', EMONEY: '電子マネー', QR: 'QRコード決済', STRIPE: 'Stripe', SQUARE: 'Square', CUSTOM: 'その他',
};

export const METHOD_SHORT: Record<PaymentMethodName, string> = {
  CASH: '現金', CARD: 'カード', EMONEY: '電子マネー', QR: 'QR決済', STRIPE: 'Stripe', SQUARE: 'Square', CUSTOM: 'その他',
};

export const TX_STATUSES = ['DRAFT', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOID'] as const;
export type TxStatusName = (typeof TX_STATUSES)[number];
export const TX_STATUS_LABEL: Record<TxStatusName, string> = {
  DRAFT: '下書き', PAID: '会計済', PARTIALLY_REFUNDED: '一部返金', REFUNDED: '返金済', VOID: '取消',
};
export const TX_STATUS_TONE: Record<TxStatusName, 'gray' | 'green' | 'amber' | 'red' | 'blue'> = {
  DRAFT: 'blue', PAID: 'green', PARTIALLY_REFUNDED: 'amber', REFUNDED: 'red', VOID: 'gray',
};

export const LINE_KIND_LABEL = { SERVICE: '施術', RETAIL: '店販', OTHER: 'その他' } as const;

export const POINT_REASON = {
  EARN: '来店ポイント',
  USE: 'ポイント利用',
  REFUND_EARN: '返金によるポイント取消',
  REFUND_USE: '返金によるポイント返還',
  VOID_EARN: '取消によるポイント取消',
  VOID_USE: '取消によるポイント返還',
} as const;

export const ORDER_STATUS_LABEL = { PENDING: '支払い待ち', PAID: '支払い済み', FULFILLED: '発送済み', CANCELLED: 'キャンセル', REFUNDED: '返金済み' } as const;
export const ORDER_STATUS_TONE = { PENDING: 'amber', PAID: 'blue', FULFILLED: 'green', CANCELLED: 'gray', REFUNDED: 'red' } as const;
export const SUB_STATUS_LABEL: Record<string, string> = { ACTIVE: '継続中', PAUSED: '一時停止', CANCELLED: '解約' };

/** Cash rows store the amount applied to the ticket; the tendered amount is kept in the label. */
export const CASH_TENDER_PREFIX = 'お預り:';
export function cashTendered(p: { method: string; label: string | null; amount: number }): number {
  if (p.method !== 'CASH' || !p.label?.startsWith(CASH_TENDER_PREFIX)) return p.amount;
  const n = Number(p.label.slice(CASH_TENDER_PREFIX.length));
  return Number.isFinite(n) && n >= p.amount ? n : p.amount;
}
export function paymentLabel(p: { method: string; label: string | null }): string {
  const base = METHOD_LABEL[p.method as PaymentMethodName] ?? p.method;
  if (p.method === 'CASH') return base;
  if (p.method === 'CUSTOM') return p.label || base;
  return p.label ? `${base}（${p.label}）` : base;
}

// ── Input schemas (validated again on the server) ──

const yenInt = (max = 10_000_000) => z.coerce.number({ invalid_type_error: '数値を入力してください' }).int('整数で入力してください').min(0, '0以上で入力してください').max(max, '金額が大きすぎます');

export const lineSchema = z.object({
  kind: z.enum(['SERVICE', 'RETAIL', 'OTHER']),
  menuId: z.string().min(1).nullish(),
  productId: z.string().min(1).nullish(),
  name: z.string().trim().min(1, '品目名を入力してください').max(100),
  unitPrice: yenInt(),
  quantity: z.coerce.number().int().min(1, '数量は1以上').max(999),
  discount: yenInt().default(0),
  staffId: z.string().min(1).nullish(),
  nominated: z.boolean().default(false),
});
export type DraftLine = z.infer<typeof lineSchema>;

export const draftSchema = z.object({
  customerId: z.string().min(1).nullish(),
  staffId: z.string().min(1).nullish(),
  lines: z.array(lineSchema).max(100, '明細は100行までです'),
  couponId: z.string().min(1).nullish(),
  manualDiscount: yenInt().default(0),
  pointsToUse: yenInt(100_000_000).default(0),
  note: z.string().trim().max(500).nullish(),
});
export type DraftInput = z.infer<typeof draftSchema>;

export const tenderSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amount: yenInt(),
  label: z.string().trim().max(60).nullish(),
  reference: z.string().trim().max(120).nullish(),
});
export type TenderInput = z.infer<typeof tenderSchema> & { externalRef?: string | null };

export const STORE_SHIPPING_FEE = 660;
export const STORE_FREE_SHIPPING_FROM = 5500;
export function shippingFeeFor(subtotal: number): number {
  return subtotal <= 0 || subtotal >= STORE_FREE_SHIPPING_FROM ? 0 : STORE_SHIPPING_FEE;
}
