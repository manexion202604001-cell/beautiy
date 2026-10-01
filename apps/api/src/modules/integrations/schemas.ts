import { z } from 'zod';
import { uuid } from '../../lib/schemas.js';

const externalKey = z.string().min(1).max(100);

/** e-mail ingestion connectors (Hot Pepper / LiME booking-notification mails) */
export const MAIL_LABEL_FIELDS = ['reservationNo', 'datetime', 'date', 'time', 'end', 'duration', 'name', 'kana', 'phone', 'email', 'staff', 'menu', 'amount', 'note'] as const;
export const mailConfigSchema = z.object({
  /** secret part of the inbound webhook URL (generated on create) */
  inboundToken: z.string().min(16).max(100).optional(),
  /** extra label spellings per field, tried before the defaults */
  labels: z.partialRecord(z.enum(MAIL_LABEL_FIELDS), z.array(z.string().min(1).max(40)).max(10)).optional(),
  /** only mails whose subject contains one of these are processed (empty = all booking-like mails) */
  subjectIncludes: z.array(z.string().min(1).max(60)).max(10).optional(),
  /** used when a menu name in the mail is not in menuMap and cannot be matched by name */
  defaultMenuId: uuid.optional(),
  /** match staff / menu names to Salon OS names automatically when not in the maps (default true) */
  autoMatchNames: z.boolean().optional(),
  /** where "block this slot on the medium" requests are e-mailed (default: shop e-mail) */
  notifyEmails: z.array(z.string().email()).max(5).optional(),
  /** Mailgun webhook signing key (optional extra verification) */
  mailgunSigningKey: z.string().max(200).optional(),
});
export type MailConfig = z.infer<typeof mailConfigSchema>;

const configFields = {
  staffMap: z.record(externalKey, uuid),
  menuMap: z.record(externalKey, uuid),
  conflictPolicy: z.enum(['manual', 'external_wins', 'internal_wins']),
  pushBlocks: z.boolean(),
  mail: mailConfigSchema,
};

/** full config with defaults (stored shape) */
export const integrationConfigSchema = z.object({
  staffMap: configFields.staffMap.default({}),
  menuMap: configFields.menuMap.default({}),
  conflictPolicy: configFields.conflictPolicy.default('manual'),
  pushBlocks: configFields.pushBlocks.default(false),
  mail: configFields.mail.optional(),
});

export const createIntegrationSchema = z.object({
  provider: z.string().min(1).max(50),
  shopId: uuid,
  displayName: z.string().min(1).max(100),
  credentials: z.record(z.string(), z.unknown()).optional(),
  config: integrationConfigSchema.prefault({}),
});
export type CreateIntegrationInput = z.infer<typeof createIntegrationSchema>;

// PATCH: no defaults (would overwrite stored values)
export const updateIntegrationSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
  config: z.object(configFields).partial().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export type UpdateIntegrationInput = z.infer<typeof updateIntegrationSchema>;

export const resyncSchema = z.object({ mode: z.enum(['delta', 'full']).default('delta') });

export const listConflictsSchema = z.object({
  state: z.enum(['open', 'resolved', 'ignored']).optional(),
  type: z.enum(['overlap', 'duplicate', 'unknown_staff', 'unknown_menu', 'unknown_customer', 'stale_update', 'push_failed']).optional(),
  integrationAccountId: uuid.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListConflictsInput = z.infer<typeof listConflictsSchema>;

export const resolveConflictSchema = z.object({
  resolution: z.enum(['keep_internal', 'accept_external', 'ignore', 'manual']),
  note: z.string().max(1000).optional(),
  /** manual: link the external booking to an appointment staff created by hand */
  appointmentId: uuid.optional(),
});
export type ResolveConflictInput = z.infer<typeof resolveConflictSchema>;

export const syncJobsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});
