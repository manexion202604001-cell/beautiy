import { z } from 'zod';
import { isoDate, isoDateTime, taxRateBp, uuid, yen } from '../../lib/schemas.js';

export const menuCategorySchema = z.object({
  shopId: uuid.nullable().optional(),
  name: z.string().min(1).max(50),
  sortOrder: z.number().int().optional(),
  /** '#rrggbb' used to colour reservations of this category on the calendar; null = none */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, '色は #rrggbb 形式で指定してください')
    .nullable()
    .optional(),
  /** top-level category this one belongs to; the name is then stored in full as 「親：子」 */
  parentId: uuid.nullable().optional(),
});

/** new display order of menus or categories ({ id, sortOrder } per row) */
export const reorderSchema = z.object({
  items: z.array(z.object({ id: uuid, sortOrder: z.number().int().min(0).max(100000) })).min(1).max(1000),
});

export const MENU_TYPES = ['regular', 'coupon'] as const;
export const COUPON_TYPES = ['all', 'new', 'repeat'] as const;

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
  /** 'regular' 通常メニュー / 'coupon' クーポン (a bookable menu with its own price and duration) */
  menuType: z.enum(MENU_TYPES).optional(),
  /** coupon menus: 'all' 全員 / 'new' 新規 / 'repeat' 再来 */
  couponType: z.enum(COUPON_TYPES).nullable().optional(),
  presentationCondition: z.string().max(100).nullable().optional(),
  usageCondition: z.string().max(500).nullable().optional(),
  /** last day the menu can be booked (shop-local date) */
  expiryDate: isoDate.nullable().optional(),
  /** show 「～」 after the price */
  priceTilde: z.boolean().optional(),
  /** every category ticked on the edit form (categoryId is the first one) */
  subCategoryIds: z.array(uuid).max(50).optional(),
  /** uploaded file of purpose 'menu_image'; null removes the picture */
  imageFileId: uuid.nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
};
export const createMenuSchema = z.object(menuFields);
export type CreateMenuInput = z.infer<typeof createMenuSchema>;
export const updateMenuSchema = z.object(menuFields).partial();
export type UpdateMenuInput = z.infer<typeof updateMenuSchema>;

export const menuOverrideSchema = z.object({
  price: yen.nullable().optional(),
  durationMin: z.number().int().min(5).max(720).nullable().optional(),
  isAvailable: z.boolean().optional(),
});

/** 掲載 / 非掲載 of one menu as seen from one shop */
export const menuListingSchema = z.object({ shopId: uuid, listed: z.boolean() });

/**
 * 対応スタッフ matrix: `staffIds` are the columns on screen; for every menu the rows of those staff are
 * made to match `assignments[].staffIds` (staff outside the columns are left untouched).
 */
export const staffAssignmentsSchema = z.object({
  shopId: uuid,
  staffIds: z.array(uuid).max(500),
  assignments: z.array(z.object({ menuId: uuid, staffIds: z.array(uuid).max(500) })).max(2000),
});
export type StaffAssignmentsInput = z.infer<typeof staffAssignmentsSchema>;

/** 対応設備 matrix: same contract with resource types (設備の種類) as the columns */
export const equipmentAssignmentsSchema = z.object({
  shopId: uuid,
  resourceTypes: z.array(z.string().min(1).max(30)).max(200),
  assignments: z.array(z.object({ menuId: uuid, resourceTypes: z.array(z.string().min(1).max(30)).max(200) })).max(2000),
});
export type EquipmentAssignmentsInput = z.infer<typeof equipmentAssignmentsSchema>;

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
