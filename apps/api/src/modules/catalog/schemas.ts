import { z } from 'zod';
import { isoDateTime, taxRateBp, uuid, yen } from '../../lib/schemas.js';

export const menuCategorySchema = z.object({
  shopId: uuid.nullable().optional(),
  name: z.string().min(1).max(50),
  sortOrder: z.number().int().optional(),
});

const menuFields = {
  shopId: uuid.nullable().optional(),
  categoryId: uuid.nullable().optional(),
  name: z.string().min(1).max(100),
  description: z.string().max(2000).nullable().optional(),
  durationMin: z.number().int().min(5).max(720),
  bufferBeforeMin: z.number().int().min(0).max(240).optional(),
  bufferAfterMin: z.number().int().min(0).max(240).optional(),
  price: yen,
  priceTaxIncluded: z.boolean().optional(),
  taxRateBp: taxRateBp.optional(),
  isPublic: z.boolean().optional(),
  isConsultation: z.boolean().optional(),
  newCustomerOnly: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  resourceRequirements: z
    .array(z.object({ resourceType: z.string().min(1).max(30), offsetMin: z.number().int().min(0).default(0), durationMin: z.number().int().min(5).nullable().optional() }))
    .optional(),
  staffIds: z.array(uuid).optional(),
};
export const createMenuSchema = z.object(menuFields);
export type CreateMenuInput = z.infer<typeof createMenuSchema>;
export const updateMenuSchema = z.object(menuFields).partial().extend({ status: z.enum(['active', 'inactive']).optional() });
export type UpdateMenuInput = z.infer<typeof updateMenuSchema>;

export const menuOverrideSchema = z.object({
  price: yen.nullable().optional(),
  durationMin: z.number().int().min(5).max(720).nullable().optional(),
  isAvailable: z.boolean().optional(),
});

export const staffMenuSchema = z.object({
  menus: z.array(z.object({ menuId: uuid, durationMin: z.number().int().min(5).nullable().optional(), price: yen.nullable().optional() })),
});

export const resourceSchema = z.object({
  shopId: uuid,
  name: z.string().min(1).max(50),
  resourceType: z.string().min(1).max(30),
  sortOrder: z.number().int().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

const couponFields = {
  shopId: uuid.nullable().optional(),
  code: z.string().min(3).max(30).nullable().optional(),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).nullable().optional(),
  discountType: z.enum(['amount', 'percent', 'fixed_price']),
  discountValue: z.number().int().min(0),
  applicableMenuIds: z.array(uuid).optional(),
  minAmount: yen.optional(),
  validFrom: isoDateTime.nullable().optional(),
  validUntil: isoDateTime.nullable().optional(),
  usageLimit: z.number().int().min(1).nullable().optional(),
  perCustomerLimit: z.number().int().min(1).nullable().optional(),
  newCustomerOnly: z.boolean().optional(),
  isPublic: z.boolean().optional(),
};
export const createCouponSchema = z.object(couponFields).refine((c) => c.discountType !== 'percent' || c.discountValue <= 100, { message: '割引率は100以下' });
export type CreateCouponInput = z.infer<typeof createCouponSchema>;
export const updateCouponSchema = z.object(couponFields).partial().extend({ status: z.enum(['active', 'inactive']).optional() });
export type UpdateCouponInput = z.infer<typeof updateCouponSchema>;
