import { z } from 'zod';

/** Shop-level operational settings stored in shops.settings (validated + defaulted here) */
export const shopSettingsSchema = z.object({
  booking: z
    .object({
      slotIntervalMin: z.number().int().min(5).max(120).default(15),
      /** minimum minutes between now and the start of an online booking */
      leadTimeMin: z.number().int().min(0).max(60 * 24 * 7).default(60),
      /** how far ahead online booking is open */
      horizonDays: z.number().int().min(1).max(365).default(60),
      /** customers may cancel/change online until N hours before start */
      cancelDeadlineHours: z.number().int().min(0).max(24 * 14).default(24),
      allowStaffSelection: z.boolean().default(true),
      /** online bookings start as tentative and need staff approval */
      requireApproval: z.boolean().default(false),
      maxServicesPerBooking: z.number().int().min(1).max(10).default(5),
      /** free (フリー) bookings: auto-assign the least busy available staff */
      autoAssignFree: z.boolean().default(true),
    })
    .prefault({}),
  reminders: z
    .object({
      enabled: z.boolean().default(true),
      confirmation: z.boolean().default(true),
      /** send the day-before reminder at this local hour */
      dayBeforeHour: z.number().int().min(0).max(23).default(18),
      /** send the same-day reminder N hours before start (0 disables) */
      sameDayHoursBefore: z.number().int().min(0).max(12).default(3),
    })
    .prefault({}),
  pos: z
    .object({
      /** points earned per 100 yen (basis points of total): 100 = 1% */
      pointRateBp: z.number().int().min(0).max(10000).default(100),
      pointExpiryDays: z.number().int().min(0).max(3650).default(365),
      roundingMode: z.enum(['floor', 'round', 'ceil']).default('floor'),
      receiptFooter: z.string().max(500).default('ご来店ありがとうございました。'),
      requireOpenRegister: z.boolean().default(true),
    })
    .prefault({}),
  review: z
    .object({
      autoRequest: z.boolean().default(true),
      requestDelayHours: z.number().int().min(0).max(72).default(3),
      googleReviewUrl: z.string().url().optional(),
    })
    .prefault({}),
});

export type ShopSettings = z.infer<typeof shopSettingsSchema>;

export function parseShopSettings(raw: unknown): ShopSettings {
  return shopSettingsSchema.parse(raw ?? {});
}

/** Deep-merge a partial patch into settings and re-validate */
export function mergeShopSettings(current: unknown, patch: unknown): ShopSettings {
  const base = parseShopSettings(current) as Record<string, Record<string, unknown>>;
  const p = (patch ?? {}) as Record<string, Record<string, unknown>>;
  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(p)) {
    merged[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(base[k] ?? {}), ...v } : v;
  }
  return shopSettingsSchema.parse(merged);
}
