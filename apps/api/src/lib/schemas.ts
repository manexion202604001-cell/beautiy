import { z } from 'zod';

/** Shared zod primitives used by request schemas across modules */
export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD形式で指定してください');
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'HH:mm形式で指定してください');
export const isoDateTime = z.string().datetime({ offset: true });
export const yen = z.number().int().min(0).max(100_000_000);
export const taxRateBp = z.number().int().min(0).max(5000);
export const idParam = z.object({ id: uuid });
export const okResponse = z.object({ ok: z.literal(true) });

/** Turns empty strings from query strings into undefined */
export const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

export const booleanQuery = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === true || v === 'true' || v === '1'));
