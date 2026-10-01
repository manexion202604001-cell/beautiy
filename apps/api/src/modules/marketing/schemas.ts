import { z } from 'zod';
import { booleanQuery, isoDate, uuid } from '../../lib/schemas.js';

const utmValue = z
  .string()
  .max(100)
  .regex(/^[\w.\-~+%]*$/, 'UTMパラメータは英数字と - _ . ~ + % のみ使用できます');

export const utmSchema = z.object({ source: utmValue.optional(), medium: utmValue.optional(), campaign: utmValue.optional() });

export const referralTarget = z.enum(['booking', 'product', 'profile', 'review']);

export const createReferralLinkSchema = z.object({
  name: z.string().min(1).max(100),
  shopId: uuid.nullable().optional(),
  staffId: uuid.nullable().optional(),
  customerId: uuid.nullable().optional(),
  target: referralTarget.default('booking'),
  targetId: uuid.nullable().optional(),
  utm: utmSchema.default({}),
});
export type CreateReferralLinkInput = z.infer<typeof createReferralLinkSchema>;

// PATCH: no defaults
export const updateReferralLinkSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  shopId: uuid.nullable().optional(),
  staffId: uuid.nullable().optional(),
  targetId: uuid.nullable().optional(),
  utm: utmSchema.optional(),
  isActive: z.boolean().optional(),
});
export type UpdateReferralLinkInput = z.infer<typeof updateReferralLinkSchema>;

export const listReferralLinksSchema = z.object({
  shopId: uuid.optional(),
  staffId: uuid.optional(),
  customerId: uuid.optional(),
  target: referralTarget.optional(),
  active: booleanQuery,
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListReferralLinksInput = z.infer<typeof listReferralLinksSchema>;

export const statsQuerySchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });

export const snsTemplate = z.enum(['square_style', 'before_after', 'review_quote']);

export const createSnsAssetSchema = z.object({
  template: snsTemplate,
  caption: z.string().max(300).default(''),
  hashtags: z
    .array(z.string().trim().min(1).max(50))
    .max(30)
    .default([])
    .transform((tags) => [...new Set(tags.map((t) => t.replace(/^[#＃]+/, '').trim()).filter(Boolean))]),
  karteAssetId: uuid.optional(),
  reviewId: uuid.optional(),
  /** explicit confirmation that the customer agreed to publish the photo (写真掲載同意) */
  customerConsent: z.boolean().default(false),
  shopId: uuid.optional(),
  staffId: uuid.optional(),
});
export type CreateSnsAssetInput = z.infer<typeof createSnsAssetSchema>;

export const listSnsAssetsSchema = z.object({
  shopId: uuid.optional(),
  staffId: uuid.optional(),
  template: snsTemplate.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListSnsAssetsInput = z.infer<typeof listSnsAssetsSchema>;
