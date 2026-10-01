import { z } from 'zod';
import { isoDate, isoDateTime, uuid } from '../../lib/schemas.js';

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'] as const;
export const WEBHOOK_STATUSES = ['received', 'processing', 'processed', 'failed', 'ignored', 'dead'] as const;
export const EXPORT_KINDS = ['customers', 'appointments', 'transactions', 'transaction_items', 'staff_sales'] as const;

export const listJobsSchema = z.object({
  state: z.enum(JOB_STATES).default('dead'),
  type: z.string().max(100).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListJobsInput = z.infer<typeof listJobsSchema>;

export const listWebhookEventsSchema = z.object({
  status: z.enum(WEBHOOK_STATUSES).optional(),
  provider: z.string().max(50).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListWebhookEventsInput = z.infer<typeof listWebhookEventsSchema>;

export const auditSearchSchema = z.object({
  actorId: uuid.optional(),
  /** exact action, or a prefix ending with '*' (e.g. "customer.*") */
  action: z.string().max(100).optional(),
  resourceType: z.string().max(100).optional(),
  resourceId: z.string().max(200).optional(),
  shopId: uuid.optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditSearchInput = z.infer<typeof auditSearchSchema>;

export const createExportSchema = z.object({
  kind: z.enum(EXPORT_KINDS),
  params: z
    .object({
      from: isoDate.optional(),
      to: isoDate.optional(),
      shopId: uuid.optional(),
    })
    .refine((p) => !p.from || !p.to || p.from <= p.to, { message: '期間の開始日は終了日以前にしてください' })
    .prefault({}),
});
export type CreateExportInput = z.infer<typeof createExportSchema>;

export const listExportsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const flagKeyParam = z.object({ key: z.string().min(1).max(100).regex(/^[a-z0-9_.-]+$/) });
export const putFlagSchema = z.object({
  enabled: z.boolean(),
  rollout: z.object({ percentage: z.number().int().min(0).max(100).optional() }).optional(),
});
