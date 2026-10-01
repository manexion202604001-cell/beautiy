import { z } from 'zod';
import { isoDate, uuid } from '../../lib/schemas.js';

const slug = z
  .string()
  .min(3)
  .max(50)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, '英小文字・数字・ハイフンのみ使用できます');

export const signupSchema = z.object({
  organizationName: z.string().min(1).max(100),
  organizationSlug: slug,
  shopName: z.string().min(1).max(100),
  shopSlug: slug,
  ownerName: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(10).max(200),
  phone: z.string().max(30).optional(),
  timezone: z.string().optional(),
  plan: z.enum(['solo', 'standard', 'pro', 'enterprise']).optional(),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const updateOrganizationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  timezone: z.string().optional(),
  invoiceRegistrationNumber: z
    .string()
    .regex(/^T\d{13}$/, '適格請求書発行事業者登録番号は T+13桁 です')
    .nullable()
    .optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

const shopBase = {
  name: z.string().min(1).max(100),
  slug,
  timezone: z.string().optional(),
  phone: z.string().max(30).nullable().optional(),
  email: z.string().email().nullable().optional(),
  postalCode: z.string().max(10).nullable().optional(),
  prefecture: z.string().max(20).nullable().optional(),
  city: z.string().max(50).nullable().optional(),
  addressLine: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
};
export const createShopSchema = z.object(shopBase);
export type CreateShopInput = z.infer<typeof createShopSchema>;
export const updateShopSchema = z
  .object(shopBase)
  .partial()
  .extend({
    status: z.enum(['active', 'inactive', 'closed']).optional(),
    publicBookingEnabled: z.boolean().optional(),
  });
export type UpdateShopInput = z.infer<typeof updateShopSchema>;

const publicProfile = z
  .object({
    bio: z.string().max(2000).optional(),
    specialties: z.array(z.string().max(50)).max(20).optional(),
    instagram: z.string().max(100).optional(),
    photoFileId: uuid.optional(),
    yearsOfExperience: z.number().int().min(0).max(80).optional(),
  })
  .partial();

export const createStaffSchema = z.object({
  displayName: z.string().min(1).max(100),
  displayNameKana: z.string().max(100).optional(),
  email: z.string().email().optional(),
  initialPassword: z.string().min(10).max(200).optional(),
  phone: z.string().max(30).optional(),
  roleId: uuid,
  shopIds: z.array(uuid).default([]),
  employmentType: z.enum(['full_time', 'part_time', 'contractor', 'owner']).optional(),
  title: z.string().max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  isBookable: z.boolean().optional(),
  nominationFee: z.number().int().min(0).max(100000).optional(),
  publicProfile: publicProfile.optional(),
  publicSlug: z.string().max(50).optional(),
  sortOrder: z.number().int().optional(),
  hiredOn: isoDate.optional(),
});
export type CreateStaffInput = z.infer<typeof createStaffSchema>;

export const updateStaffSchema = createStaffSchema
  .omit({ shopIds: true, initialPassword: true })
  .partial()
  .extend({
    status: z.enum(['invited', 'active', 'inactive', 'retired']).optional(),
    retiredOn: isoDate.nullable().optional(),
  });
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;

export const transferStaffSchema = z.object({
  fromShopId: uuid,
  toShopId: uuid,
  effectiveDate: isoDate.optional(),
  customerPolicy: z.enum(['keep', 'reassign', 'unassign']).default('keep'),
  reassignToStaffId: uuid.optional(),
});
export type TransferStaffInput = z.infer<typeof transferStaffSchema>;

export const roleSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  name: z.string().min(1).max(50),
  description: z.string().max(200).optional(),
  permissions: z.array(z.string()).default([]),
});
/** PATCH: no defaults (a default [] would wipe the role's permissions on rename) */
export const updateRoleSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  description: z.string().max(200).optional(),
  permissions: z.array(z.string()).optional(),
});

