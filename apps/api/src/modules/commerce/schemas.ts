import { z } from 'zod';
import { booleanQuery, isoDate, optionalString, taxRateBp, uuid, yen } from '../../lib/schemas.js';

const productFields = {
  shopId: uuid.nullable().optional(),
  sku: z.string().trim().min(1).max(64).nullable().optional(),
  barcode: z.string().trim().min(1).max(64).nullable().optional(),
  name: z.string().trim().min(1).max(200),
  brand: z.string().max(100).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  price: yen,
  priceTaxIncluded: z.boolean(),
  cost: yen.nullable().optional(),
  taxRateBp,
  imageFileIds: z.array(uuid).max(10),
  isOnline: z.boolean(),
  stockManaged: z.boolean(),
  status: z.enum(['active', 'inactive']),
};

export const createProductSchema = z.object({
  ...productFields,
  priceTaxIncluded: productFields.priceTaxIncluded.default(true),
  taxRateBp: productFields.taxRateBp.default(1000),
  imageFileIds: productFields.imageFileIds.default([]),
  isOnline: productFields.isOnline.default(false),
  stockManaged: productFields.stockManaged.default(true),
  status: productFields.status.default('active'),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

// PATCH: no defaults. shop_id is not changeable (stock/movements are bound to it)
export const updateProductSchema = z.object(productFields).omit({ shopId: true }).partial();
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const listProductsSchema = z.object({
  q: optionalString,
  shopId: uuid.optional(),
  category: optionalString,
  barcode: optionalString,
  isOnline: booleanQuery,
  status: z.enum(['active', 'inactive']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListProductsInput = z.infer<typeof listProductsSchema>;

export const stockAdjustmentSchema = z
  .object({
    /** null = EC warehouse */
    shopId: uuid.nullable(),
    delta: z.number().int().min(-100000).max(100000).refine((v) => v !== 0, '0以外の数量を指定してください'),
    reason: z.enum(['receive', 'adjust', 'transfer', 'return']),
    /** transfer destination (null = EC warehouse); required for reason=transfer */
    toShopId: uuid.nullable().optional(),
    note: z.string().max(500).optional(),
  })
  .refine((v) => v.reason !== 'transfer' || (v.toShopId !== undefined && v.delta > 0 && v.toShopId !== v.shopId), {
    message: '移動(transfer)は移動先(toShopId)と正の数量が必要です',
  })
  .refine((v) => !['receive', 'return'].includes(v.reason) || v.delta > 0, { message: '入荷・返品は正の数量で指定してください' });
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;

export const stockSettingsSchema = z.object({ shopId: uuid.nullable(), reorderPoint: z.number().int().min(0).max(100000).nullable() });

export const lowStockSchema = z.object({ shopId: uuid.optional() });

export const shareProductSchema = z.object({ customerId: uuid, message: z.string().max(500).optional() });

export const publicProductsSchema = z.object({
  category: optionalString,
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const shippingAddressSchema = z.object({
  postalCode: z.string().regex(/^\d{3}-?\d{4}$/, '郵便番号はハイフンあり/なしの7桁で入力してください'),
  prefecture: z.string().min(2).max(10),
  city: z.string().min(1).max(100),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  name: z.string().min(1).max(100),
  phone: z.string().regex(/^[0-9+\-() ]{10,20}$/, '電話番号の形式が正しくありません'),
});
export type ShippingAddress = z.infer<typeof shippingAddressSchema>;

export const createOrderSchema = z.object({
  shopSlug: z.string().min(1).max(60),
  items: z
    .array(z.object({ productId: uuid, quantity: z.number().int().min(1).max(99) }))
    .min(1)
    .max(50),
  shippingAddress: shippingAddressSchema,
  contactEmail: z.string().email().optional(),
  referralCode: z.string().max(50).optional(),
  note: z.string().max(1000).optional(),
  channel: z.enum(['online', 'line']).default('online'),
  idempotencyKey: z.string().min(8).max(100),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const orderStatus = z.enum(['pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded']);

export const listOrdersSchema = z.object({
  status: orderStatus.optional(),
  customerId: uuid.optional(),
  shopId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListOrdersInput = z.infer<typeof listOrdersSchema>;

export const shipOrderSchema = z.object({ carrier: z.string().min(1).max(50), trackingNumber: z.string().min(1).max(100) });
export const cancelOrderSchema = z.object({ reason: z.string().min(1).max(500) });

export const salesQuerySchema = z
  .object({ from: isoDate, to: isoDate, groupBy: z.enum(['product', 'staff']).default('product'), shopId: uuid.optional() })
  .refine((v) => v.from <= v.to, { message: 'from は to 以前の日付を指定してください' });
export type SalesQueryInput = z.infer<typeof salesQuerySchema>;
