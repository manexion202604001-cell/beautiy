/**
 * Read contract for other modules: how an appointment stands with the booking media
 * (Hot Pepper Beauty / SALON BOARD, LiME ...). Shown on the calendar and the appointment detail so
 * staff see at a glance whether a slot still has to be blocked on a medium (ADR 0010).
 */
import type { Ctx } from '../../auth/actor.js';
import { integrationConfigSchema } from './schemas.js';

const SALONBOARD = 'hotpepper_mail';
/** what the 自動枠止め helper writes into last_error when it could not carry a request out */
export const AGENT_ERROR_PREFIX = '自動枠止め:';

/** SALON BOARD as the 予約詳細 SB chip / SB連携 row show it (SALOGIC salonboard_synced) */
export interface SalonboardSync {
  /** the shop's SALON BOARD connector blocks slots (店舗設定 › サロンボード) */
  enabled: boolean;
  /** slot blocking is done by the 自動枠止め helper (every 10 minutes) */
  auto: boolean;
  /** the booking is on SALON BOARD by itself: an HPB booking, or one copied from the previous system */
  origin: 'hotpepper' | 'migrated' | null;
  /** HPB reservation number of an HPB booking (BE…) */
  reserve_id: string | null;
  /** synced = in place on SALON BOARD (or nothing to do there), waiting = the helper has not run yet,
   * error = it failed; null = nothing asked yet */
  state: 'synced' | 'waiting' | 'error' | null;
  /** why: the helper's error, or what it found (「サロンボードに同じ時間の予定があります」…) */
  message: string | null;
  /** when the state was last settled */
  synced_at: Date | null;
}

export interface AppointmentMediaSync {
  /** the medium this booking came from; null = taken in Salon OS */
  origin: {
    provider: string;
    integration_account_id: string;
    /** the medium's booking number (HPB: BE…) */
    external_id: string;
    sync_state: string;
    last_synced_at: Date | null;
    last_error: string | null;
  } | null;
  /** slot blocks on the other media: action_required / remove_required are open staff tasks */
  blocks: {
    id: string;
    provider: string;
    integration_account_id: string;
    state: string;
    manual: boolean;
    last_error: string | null;
    /** the helper settled it without changing the medium (the slot is held there already …) */
    skipped: string | null;
    pushed_at: Date | null;
    done_at: Date | null;
    updated_at: Date;
  }[];
  /** present when the shop has a SALON BOARD connector */
  salonboard?: SalonboardSync;
}

function skippedOf(record: string | null): string | null {
  if (!record || !record.startsWith('{')) return null;
  try {
    const v = JSON.parse(record) as { skipped?: unknown };
    return typeof v.skipped === 'string' ? v.skipped : null;
  } catch {
    return null;
  }
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
  const [bookings, blocks, appts] = await Promise.all([
    ctx.trx
      .selectFrom('external_bookings')
      .select([
        'appointment_id',
        'provider',
        'integration_account_id',
        'external_booking_id',
        'sync_state',
        'last_synced_at',
        'last_error',
      ])
      .where('appointment_id', 'in', appointmentIds)
      .orderBy('updated_at')
      .execute(),
    ctx.trx
      .selectFrom('external_slot_blocks as b')
      .innerJoin('integration_accounts as ia', 'ia.id', 'b.integration_account_id')
      .select([
        'b.id',
        'b.appointment_id',
        'b.integration_account_id',
        'b.state',
        'b.manual',
        'b.last_error',
        'b.external_block_id',
        'b.pushed_at',
        'b.done_at',
        'b.updated_at',
        'ia.provider',
      ])
      .where('b.appointment_id', 'in', appointmentIds)
      .orderBy('b.created_at')
      .execute(),
    ctx.trx
      .selectFrom('appointments')
      .select(['id', 'shop_id', 'source', 'source_detail'])
      .where('id', 'in', appointmentIds)
      .execute(),
  ]);
  const shopIds = [...new Set(appts.map((a) => a.shop_id))];
  const sbAccounts = shopIds.length
    ? await ctx.trx
        .selectFrom('integration_accounts')
        .select(['id', 'shop_id', 'status', 'config'])
        .where('provider', '=', SALONBOARD)
        .where('shop_id', 'in', shopIds)
        .where('status', '!=', 'disabled')
        .execute()
    : [];

  for (const b of bookings) {
    if (b.appointment_id)
      entry(b.appointment_id).origin = {
        provider: b.provider,
        integration_account_id: b.integration_account_id,
        external_id: b.external_booking_id,
        sync_state: b.sync_state,
        last_synced_at: b.last_synced_at,
        last_error: b.last_error,
      };
  }
  for (const b of blocks) {
    entry(b.appointment_id).blocks.push({
      id: b.id,
      provider: b.provider,
      integration_account_id: b.integration_account_id,
      state: b.state,
      manual: b.manual,
      last_error: b.last_error,
      skipped: b.state === 'pushed' ? skippedOf(b.external_block_id) : null,
      pushed_at: b.pushed_at,
      done_at: b.done_at,
      updated_at: b.updated_at,
    });
  }

  for (const a of appts) {
    const acc = sbAccounts.find((x) => x.shop_id === a.shop_id);
    if (!acc) continue;
    const parsed = integrationConfigSchema.safeParse(acc.config ?? {});
    const cfg = parsed.success ? parsed.data : integrationConfigSchema.parse({});
    const e = entry(a.id);
    const sb: SalonboardSync = {
      enabled: cfg.pushBlocks,
      auto: cfg.pushBlocks && !!cfg.mail?.agentManaged,
      origin: null,
      reserve_id: null,
      state: null,
      message: null,
      synced_at: null,
    };
    const hpb = bookings
      .filter((b) => b.appointment_id === a.id && b.provider === SALONBOARD)
      .at(-1);
    const migrated =
      a.source === 'import' || !!(a.source_detail as { migrated?: boolean } | null)?.migrated;
    if (hpb) {
      sb.origin = 'hotpepper';
      sb.reserve_id = hpb.external_booking_id;
      const bad = hpb.sync_state === 'error' || hpb.sync_state === 'conflict';
      sb.state = bad ? 'error' : 'synced';
      sb.message = bad ? hpb.last_error : null;
      sb.synced_at = hpb.last_synced_at;
    } else {
      const block = e.blocks.filter((b) => b.integration_account_id === acc.id).at(-1);
      if (migrated && !block) {
        sb.origin = 'migrated';
        sb.state = 'synced';
      } else if (block) {
        if (block.state === 'pushed') {
          sb.state = 'synced';
          sb.message = block.skipped;
          sb.synced_at = block.done_at ?? block.pushed_at ?? block.updated_at;
        } else if (block.state === 'error') {
          sb.state = 'error';
          sb.message = block.last_error;
          sb.synced_at = block.updated_at;
        } else if (
          block.state === 'action_required' ||
          block.state === 'remove_required' ||
          block.state === 'pending'
        ) {
          const failed = !!block.last_error?.startsWith(AGENT_ERROR_PREFIX);
          sb.state = failed ? 'error' : 'waiting';
          sb.message = block.last_error;
          sb.synced_at = block.updated_at;
        }
        // removed: the booking no longer holds a slot on SALON BOARD
      }
    }
    e.salonboard = sb;
  }
  return out;
}

export const NO_MEDIA_SYNC: AppointmentMediaSync = { origin: null, blocks: [] };
