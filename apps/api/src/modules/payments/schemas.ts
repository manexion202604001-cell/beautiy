import { z } from 'zod';
import { uuid, yen } from '../../lib/schemas.js';

const idempotencyKey = z.string().min(1).max(255);

export const startPaymentSchema = z
  .object({
    transactionId: uuid.optional(),
    orderId: uuid.optional(),
    /** defaults to the outstanding balance */
    amount: yen.min(1).optional(),
    idempotencyKey: idempotencyKey.optional(),
    description: z.string().max(500).optional(),
  })
  .refine((v) => (v.transactionId ? 1 : 0) + (v.orderId ? 1 : 0) === 1, { message: 'transactionIdかorderIdのどちらか一方を指定してください' });
export type StartPaymentInput = z.infer<typeof startPaymentSchema>;

export const refundSchema = z.object({
  /** defaults to the remaining refundable amount */
  amount: yen.min(1).optional(),
  reason: z.string().max(500).optional(),
  idempotencyKey: idempotencyKey.optional(),
});
export type RefundRequestInput = z.infer<typeof refundSchema>;

export const mockCompleteSchema = z.object({
  success: z.boolean().default(true),
  failureCode: z.string().max(100).optional(),
  failureReason: z.string().max(500).optional(),
});

export const listCustomMethodsSchema = z.object({
  shopId: uuid.optional(),
  includeInactive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true'),
});

export const createCustomMethodSchema = z.object({
  shopId: uuid.nullable().optional(),
  name: z.string().min(1).max(50),
  countsAsSales: z.boolean().default(true),
});
export type CreateCustomMethodInput = z.infer<typeof createCustomMethodSchema>;

export const updateCustomMethodSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  isActive: z.boolean().optional(),
  countsAsSales: z.boolean().optional(),
});
export type UpdateCustomMethodInput = z.infer<typeof updateCustomMethodSchema>;
