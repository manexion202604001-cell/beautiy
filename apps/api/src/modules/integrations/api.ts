/**
 * Read contract for other modules: how an appointment stands with the booking media
 * (Hot Pepper Beauty / SALON BOARD, LiME ...). Shown on the calendar and the appointment detail so
 * staff see at a glance whether a slot still has to be blocked on a medium (ADR 0010).
 */
import type { Ctx } from '../../auth/actor.js';

export interface AppointmentMediaSync {
  /** the medium this booking came from; null = taken in Salon OS */
  origin: {
    provider: string;
    sync_state: string;
    last_synced_at: Date | null;
    last_error: string | null;
  } | null;
  /** slot blocks on the other media: action_required / remove_required are open staff tasks */
  blocks: {
    id: string;
    provider: string;
    state: string;
    manual: boolean;
    last_error: string | null;
    updated_at: Date;
  }[];
}

export async function appointmentMediaSync(
  ctx: Ctx,
  appointmentIds: string[],
): Promise<Map<string, AppointmentMediaSync>> {
  const out = new Map<string, AppointmentMediaSync>();
  if (!appointmentIds.length) return out;
  const entry = (id: string) => {
    let e = out.get(id);
    if (!e) out.set(id, (e = { origin: null, blocks: [] }));
    return e;
  };
  const [bookings, blocks] = await Promise.all([
    ctx.trx
      .selectFrom('external_bookings')
      .select(['appointment_id', 'provider', 'sync_state', 'last_synced_at', 'last_error'])
      .where('appointment_id', 'in', appointmentIds)
      .orderBy('updated_at')
      .execute(),
    ctx.trx
      .selectFrom('external_slot_blocks as b')
      .innerJoin('integration_accounts as ia', 'ia.id', 'b.integration_account_id')
      .select([
        'b.id',
        'b.appointment_id',
        'b.state',
        'b.manual',
        'b.last_error',
        'b.updated_at',
        'ia.provider',
      ])
      .where('b.appointment_id', 'in', appointmentIds)
      .orderBy('b.created_at')
      .execute(),
  ]);
  for (const b of bookings) {
    if (b.appointment_id)
      entry(b.appointment_id).origin = {
        provider: b.provider,
        sync_state: b.sync_state,
        last_synced_at: b.last_synced_at,
        last_error: b.last_error,
      };
  }
  for (const b of blocks) {
    entry(b.appointment_id).blocks.push({
      id: b.id,
      provider: b.provider,
      state: b.state,
      manual: b.manual,
      last_error: b.last_error,
      updated_at: b.updated_at,
    });
  }
  return out;
}

export const NO_MEDIA_SYNC: AppointmentMediaSync = { origin: null, blocks: [] };
