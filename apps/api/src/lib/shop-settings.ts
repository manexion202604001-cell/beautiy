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
      // ---- 予約受付設定 › 予約設定 (online bookings; staff with their own 予約設定 use those instead)
      /** 受付開始: open until the last day of (this month + N months). null = horizonDays applies */
      advanceMonths: z.number().int().min(1).max(12).nullable().default(null),
      /** 受付締切: 'same_day' = until leadTimeMin before the start, 'days_before' = until cutoffTime on the day cutoffDaysBefore days earlier */
      cutoffType: z.enum(['same_day', 'days_before']).default('same_day'),
      cutoffDaysBefore: z.number().int().min(1).max(30).default(1),
      /** 'HH:MM' shop-local; '24:00' = the end of that day */
      cutoffTime: z.string().regex(/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/).default('24:00'),
      /** 受付期間の計算方法: count days on the calendar or only days the shop is open */
      calcMethod: z.enum(['calendar', 'business_days']).default('calendar'),
      /** 開始時刻が同じ予約を受付する (a staff member taking several bookings at once) */
      acceptSameStartTime: z.boolean().default(false),
      /** 営業時間外の予約を受付する */
      acceptOutsideHours: z.boolean().default(false),
    })
    .prefault({}),
  /** 予約受付設定 › 営業時間・定休日: hours on Japanese public holidays, separate from the weekday rows */
  hours: z
    .object({
      holidayEnabled: z.boolean().default(false),
      holidayClosed: z.boolean().default(false),
      holidayOpenTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default('10:00'),
      holidayCloseTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default('19:00'),
    })
    .prefault({}),
  /** 予約受付設定 › 受付可能数: online bookings the shop takes at the same time (null = no limit) */
  capacity: z
    .object({
      /** デフォルト受付可能数: used on weekdays without their own number */
      default: z.number().int().min(1).max(20).nullable().default(null),
      /** index 0 = Sunday … 6 = Saturday */
      weekdays: z.array(z.number().int().min(1).max(20).nullable()).length(7).default([null, null, null, null, null, null, null]),
      /** public holidays, when hours.holidayEnabled */
      holiday: z.number().int().min(1).max(20).nullable().default(null),
    })
    .prefault({}),
  /** 席数アラート (店舗設定): cap on bookings taking place at the same time in the shop */
  seats: z
    .object({
      /** when true, creating / moving a booking beyond `limit` simultaneous bookings is refused */
      alertEnabled: z.boolean().default(false),
      /** 同時最大予約数 (0 = not set) */
      limit: z.number().int().min(0).max(999).default(0),
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
      /** customers without LINE get the automatic messages by e-mail (then SMS). Off = LINE only, as
       * SALOGIC: only customers who added the official LINE are contacted */
      emailFallback: z.boolean().default(false),
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
  // 受付開始 / 受付締切 each have two ways of being set (days or months, minutes or a day earlier).
  // A screen that only knows the older field changes just that one: the last change decides.
  const before = base.booking ?? {};
  const sent = p.booking ?? {};
  const after = merged.booking as Record<string, unknown>;
  if (sent.horizonDays !== undefined && sent.horizonDays !== before.horizonDays && sent.advanceMonths === undefined) after.advanceMonths = null;
  if (sent.leadTimeMin !== undefined && sent.leadTimeMin !== before.leadTimeMin && sent.cutoffType === undefined) after.cutoffType = 'same_day';
  return shopSettingsSchema.parse(merged);
}
