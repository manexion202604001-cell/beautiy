import { z } from 'zod';
import { paginationQuery } from '../../lib/pagination.js';
import { isoDate, taxRateBp, uuid, yen } from '../../lib/schemas.js';

const idempotencyKey = z.string().min(1).max(255);

// ----------------------------------------------------------------- register sessions
export const openRegisterSchema = z.object({
  shopId: uuid,
  openingCash: yen.default(0),
  note: z.string().max(500).optional(),
});
export const currentRegisterSchema = z.object({ shopId: uuid });
export const cashMovementSchema = z.object({
  type: z.enum(['pay_in', 'pay_out']),
  amount: yen.min(1),
  reason: z.string().min(1).max(200),
});
const cashBreakdown = z.record(z.string().regex(/^\d+$/, '金種は数値で指定してください'), z.number().int().min(0));
export const closeRegisterSchema = z
  .object({
    countedCash: yen.optional(),
    cashBreakdown: cashBreakdown.optional(),
    note: z.string().max(500).optional(),
  })
  .refine((v) => v.countedCash !== undefined || v.cashBreakdown !== undefined, { message: 'countedCashまたはcashBreakdownを指定してください' });
export type CloseRegisterInput = z.infer<typeof closeRegisterSchema>;
export const listRegisterSchema = paginationQuery.extend({
  shopId: uuid,
  from: isoDate.optional(),
  to: isoDate.optional(),
});

// ----------------------------------------------------------------- transactions
export const createTransactionSchema = z.object({
  shopId: uuid,
  appointmentId: uuid.optional(),
  customerId: uuid.optional(),
  staffId: uuid.optional(),
  isNominated: z.boolean().optional(),
  note: z.string().max(1000).optional(),
});
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

const staffShareSchema = z.object({
  staffId: uuid,
  shareBp: z.number().int().min(0).max(10000),
  role: z.enum(['main', 'assistant', 'referral']).default('main'),
  isNominated: z.boolean().default(false),
});

export const itemInputSchema = z
  .object({
    type: z.enum(['service', 'product', 'nomination_fee', 'discount', 'coupon', 'adjustment']),
    menuId: uuid.optional(),
    productId: uuid.optional(),
    couponId: uuid.optional(),
    name: z.string().min(1).max(200).optional(),
    quantity: z.number().int().min(1).max(999).default(1),
    /** price override (tax-inclusive). adjustment: signed amount */
    unitPrice: z.number().int().min(-100_000_000).max(100_000_000).optional(),
    taxRateBp: taxRateBp.optional(),
    lineDiscount: yen.optional(),
    lineDiscountPercent: z.number().int().min(0).max(100).optional(),
    /** discount lines: yen amount or percent of the eligible total */
    amount: yen.optional(),
    percent: z.number().int().min(1).max(100).optional(),
    staff: z.array(staffShareSchema).max(10).optional(),
  })
  .superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (v.type === 'product' && !v.productId) issue('商品明細にはproductIdが必要です');
    if (v.type === 'service' && !v.menuId && (v.unitPrice === undefined || !v.name)) issue('施術明細にはmenuId(またはnameとunitPrice)が必要です');
    if (v.type === 'coupon' && !v.couponId) issue('クーポン明細にはcouponIdが必要です');
    if (v.type === 'discount' && (v.amount === undefined) === (v.percent === undefined)) issue('値引明細にはamountかpercentのどちらか一方を指定してください');
    if (v.type === 'adjustment' && (v.unitPrice === undefined || v.unitPrice === 0)) issue('調整明細にはunitPrice(0以外)が必要です');
    if (v.type !== 'adjustment' && v.unitPrice !== undefined && v.unitPrice < 0) issue('単価は0以上で指定してください');
    if (v.staff?.length) {
      const sum = v.staff.reduce((s, x) => s + x.shareBp, 0);
      if (sum !== 10000) issue('担当者の配分は合計100%(10000)にしてください');
      const keys = new Set(v.staff.map((s) => `${s.staffId}:${s.role}`));
      if (keys.size !== v.staff.length) issue('同じ担当者・役割が重複しています');
    }
  });
export type ItemInput = z.infer<typeof itemInputSchema>;

export const replaceItemsSchema = z.object({
  version: z.number().int().min(1),
  items: z.array(itemInputSchema).max(200),
  staffId: uuid.nullable().optional(),
  isNominated: z.boolean().optional(),
  customerId: uuid.nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
});
export type ReplaceItemsInput = z.infer<typeof replaceItemsSchema>;

export const pointsSchema = z.object({ use: z.number().int().min(0).max(10_000_000), idempotencyKey: idempotencyKey.optional() });

export const addPaymentSchema = z.object({
  method: z.enum(['cash', 'card', 'emoney', 'qr', 'custom', 'point']),
  /** omitted: cash = min(tendered, outstanding), others = outstanding */
  amount: yen.min(1).optional(),
  tenderedAmount: yen.optional(),
  customMethodId: uuid.optional(),
  /** card only: take the payment online through the payment provider (payments/api) */
  online: z.boolean().optional(),
  idempotencyKey: idempotencyKey.optional(),
  note: z.string().max(200).optional(),
});
export type AddPaymentInput = z.infer<typeof addPaymentSchema>;

export const listTransactionsSchema = paginationQuery.extend({
  shopId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.union([z.enum(['draft', 'completed', 'voided', 'refunded', 'partially_refunded']), z.array(z.enum(['draft', 'completed', 'voided', 'refunded', 'partially_refunded']))]).optional(),
  customerId: uuid.optional(),
  staffId: uuid.optional(),
});
export type ListTransactionsInput = z.infer<typeof listTransactionsSchema>;
export const exportTransactionsSchema = listTransactionsSchema.omit({ cursor: true, limit: true });

export const voidSchema = z.object({ reason: z.string().min(1).max(500) });

export const refundTransactionSchema = z.object({
  amount: yen.min(1),
  reason: z.string().min(1).max(500),
  paymentId: uuid.optional(),
  restockItems: z.array(z.object({ itemId: uuid, quantity: z.number().int().min(1) })).max(100).optional(),
  idempotencyKey: idempotencyKey.optional(),
});
export type RefundTransactionInput = z.infer<typeof refundTransactionSchema>;

export const receiptSchema = z.object({
  type: z.enum(['receipt', 'invoice']).default('receipt'),
  addressee: z.string().max(100).optional(),
  proviso: z.string().max(100).optional(),
});
export type ReceiptInput = z.infer<typeof receiptSchema>;

export const dailyReportSchema = z.object({ shopId: uuid, date: isoDate });
