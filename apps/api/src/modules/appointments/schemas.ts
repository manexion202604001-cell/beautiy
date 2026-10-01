import { z } from 'zod';
import { isoDate, isoDateTime, uuid } from '../../lib/schemas.js';

export const SOURCES = ['web', 'line', 'external', 'phone', 'walk_in', 'staff'] as const;
export const STATUSES = ['tentative', 'confirmed', 'checked_in', 'in_service', 'completed', 'cancelled', 'no_show'] as const;

export const createAppointmentSchema = z.object({
  shopId: uuid,
  customerId: uuid.nullable().optional(),
  /** null/omitted = フリー (auto-assign when enabled) */
  staffId: uuid.nullable().optional(),
  isNominated: z.boolean().optional(),
  startAt: isoDateTime,
  menuIds: z.array(uuid).min(1).max(10),
  couponId: uuid.nullable().optional(),
  source: z.enum(SOURCES).default('staff'),
  sourceDetail: z.record(z.string(), z.unknown()).optional(),
  customerNote: z.string().max(2000).nullable().optional(),
  staffNote: z.string().max(2000).nullable().optional(),
  status: z.enum(['tentative', 'confirmed']).optional(),
  /** staff override: allow booking outside configured shifts/business hours (never allows double booking) */
  allowOutsideSchedule: z.boolean().optional(),
});
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;

export const updateAppointmentSchema = z.object({
  version: z.number().int().min(1),
  staffId: uuid.nullable().optional(),
  isNominated: z.boolean().optional(),
  startAt: isoDateTime.optional(),
  menuIds: z.array(uuid).min(1).max(10).optional(),
  customerId: uuid.nullable().optional(),
  couponId: uuid.nullable().optional(),
  customerNote: z.string().max(2000).nullable().optional(),
  staffNote: z.string().max(2000).nullable().optional(),
  allowOutsideSchedule: z.boolean().optional(),
});
export type UpdateAppointmentInput = z.infer<typeof updateAppointmentSchema>;

export const transitionSchema = z.object({
  version: z.number().int().min(1).optional(),
  reason: z.string().max(500).optional(),
});

export const listAppointmentsSchema = z.object({
  shopId: uuid.optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  date: isoDate.optional(),
  staffId: uuid.optional(),
  customerId: uuid.optional(),
  status: z.union([z.enum(STATUSES), z.array(z.enum(STATUSES))]).optional(),
  source: z.enum(SOURCES).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
export type ListAppointmentsInput = z.infer<typeof listAppointmentsSchema>;

export const availabilitySchema = z.object({
  shopId: uuid,
  menuIds: z.union([uuid, z.array(uuid)]).transform((v) => (Array.isArray(v) ? v : [v])),
  staffId: uuid.optional(),
  from: isoDate,
  to: isoDate,
});
