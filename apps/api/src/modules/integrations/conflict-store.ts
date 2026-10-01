import type { Ctx } from '../../auth/actor.js';

export interface ConflictInput {
  type: 'overlap' | 'duplicate' | 'unknown_staff' | 'unknown_menu' | 'unknown_customer' | 'stale_update' | 'push_failed';
  externalBookingId?: string | null;
  appointmentId?: string | null;
  details: Record<string, unknown>;
  state?: 'open' | 'resolved' | 'ignored';
  resolution?: string | null;
}

/** Insert a conflict; an existing OPEN conflict of the same type for the same booking is refreshed instead */
export async function recordConflict(ctx: Ctx, input: ConflictInput): Promise<string> {
  const state = input.state ?? 'open';
  if (state === 'open') {
    let q = ctx.trx.selectFrom('sync_conflicts').select('id').where('conflict_type', '=', input.type).where('state', '=', 'open');
    q = input.externalBookingId ? q.where('external_booking_id', '=', input.externalBookingId) : q.where('external_booking_id', 'is', null).where('appointment_id', '=', input.appointmentId ?? '00000000-0000-0000-0000-000000000000');
    const existing = await q.executeTakeFirst();
    if (existing) {
      await ctx.trx.updateTable('sync_conflicts').set({ details: JSON.stringify(input.details), appointment_id: input.appointmentId ?? null }).where('id', '=', existing.id).execute();
      return existing.id;
    }
  }
  const row = await ctx.trx
    .insertInto('sync_conflicts')
    .values({
      organization_id: ctx.actor.organizationId,
      external_booking_id: input.externalBookingId ?? null,
      appointment_id: input.appointmentId ?? null,
      conflict_type: input.type,
      details: JSON.stringify(input.details),
      state,
      resolution: input.resolution ?? null,
      resolved_at: state === 'open' ? null : new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}
