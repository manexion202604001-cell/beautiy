import { z } from 'zod';
import { uuid } from '../../lib/schemas.js';

const externalKey = z.string().min(1).max(100);

const configFields = {
  staffMap: z.record(externalKey, uuid),
  menuMap: z.record(externalKey, uuid),
  conflictPolicy: z.enum(['manual', 'external_wins', 'internal_wins']),
  pushBlocks: z.boolean(),
};

/** full config with defaults (stored shape) */
export const integrationConfigSchema = z.object({
  staffMap: configFields.staffMap.default({}),
  menuMap: configFields.menuMap.default({}),
  conflictPolicy: configFields.conflictPolicy.default('manual'),
  pushBlocks: configFields.pushBlocks.default(false),
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
