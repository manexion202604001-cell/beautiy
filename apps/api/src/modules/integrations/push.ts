import type { Ctx } from '../../auth/actor.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { onEvent } from '../../lib/events.js';
import { ACTIVE_STATUSES } from '../appointments/service.js';
import { loadAccountRow, parseIntegrationConfig, toAdapterAccount } from './accounts.js';
import { getAdapter } from './adapters/registry.js';
import { recordConflict } from './conflict-store.js';
import { reconcileManualBlock } from './mail/manual.js';

/**
 * Push (internal → external): reflect internal bookings to booking media as blocked slots so the
 * medium cannot sell a slot we already hold (FR-06「内部予約の外部枠への反映」).
 * The job is convergent: it reads the appointment's CURRENT state and makes the provider match it
 * (push / move / remove), so duplicate or out-of-order jobs are harmless.
 * While an account is degraded, blocks are parked as 'pending' and replayed on recovery.
 */
export const PUSH_JOB = 'integration.push_block';
export const PUSH_MAX_ATTEMPTS = 5;

const PUSH_EVENTS = ['appointment.created', 'appointment.rescheduled', 'appointment.cancelled', 'appointment.no_show', 'appointment.restored'];

interface PushPayload {
  integrationAccountId: string;
  appointmentId: string;
}

export async function enqueuePushJob(ctx: Ctx, integrationAccountId: string, appointmentId: string, tag: string) {
  return enqueue(ctx, {
    type: PUSH_JOB,
    payload: { integrationAccountId, appointmentId } satisfies PushPayload,
    dedupeKey: `intg-push:${integrationAccountId}:${appointmentId}:${tag}`,
    maxAttempts: PUSH_MAX_ATTEMPTS,
    priority: 3,
  });
}

/** After recovery from degraded mode: reconcile every parked block */
export async function replayPendingBlocks(ctx: Ctx, integrationAccountId: string): Promise<number> {
  const rows = await ctx.trx.selectFrom('external_slot_blocks').select('appointment_id').where('integration_account_id', '=', integrationAccountId).where('state', '=', 'pending').execute();
  const tag = `replay-${Date.now()}`;
  for (const r of rows) await enqueuePushJob(ctx, integrationAccountId, r.appointment_id, tag);
  return rows.length;
}

for (const type of PUSH_EVENTS) {
  onEvent(type, async (ctx, event) => {
    const appt = await ctx.trx.selectFrom('appointments').select(['id', 'shop_id', 'source', 'source_detail', 'version']).where('id', '=', event.aggregateId).executeTakeFirst();
    if (!appt) return;
    // reservations imported from the previous system already hold their slot on the media
    if (type === 'appointment.created' && appt.source === 'import') return;
    const accounts = await ctx.trx
      .selectFrom('integration_accounts')
      .select(['id', 'provider', 'config'])
      .where('shop_id', '=', appt.shop_id)
      .where('status', '!=', 'disabled')
      .execute();
    const origin = appt.source === 'external' ? (appt.source_detail as { integrationAccountId?: string } | null)?.integrationAccountId : undefined;
    for (const acc of accounts) {
      if (!getAdapter(acc.provider)) continue;
      if (!parseIntegrationConfig(acc.config).pushBlocks) continue;
      // never echo a medium's own booking back to it as a block
      if (origin === acc.id) continue;
      await enqueuePushJob(ctx, acc.id, appt.id, `v${appt.version}`);
    }
  });
}

async function upsertBlock(
  ctx: Ctx,
  key: { integrationAccountId: string; appointmentId: string },
  patch: { state: string; external_block_id?: string | null; last_error?: string | null; block_start_at?: Date | null; block_end_at?: Date | null; staff_external_id?: string | null; pushed_at?: Date | null; attempts?: number },
) {
  await ctx.trx
    .insertInto('external_slot_blocks')
    .values({ organization_id: ctx.actor.organizationId, integration_account_id: key.integrationAccountId, appointment_id: key.appointmentId, ...patch })
    .onConflict((oc) => oc.columns(['integration_account_id', 'appointment_id']).doUpdateSet(patch))
    .execute();
}

registerJob<PushPayload>(PUSH_JOB, async (p, jc) => {
  const loaded = await jc.tx(async (ctx) => {
    const acc = await loadAccountRow(ctx.trx, p.integrationAccountId);
    const appt = await ctx.trx
      .selectFrom('appointments')
      .select(['id', 'shop_id', 'staff_id', 'status', 'occupied_start_at', 'occupied_end_at', 'deleted_at'])
      .where('id', '=', p.appointmentId)
      .executeTakeFirst();
    const block = await ctx.trx
      .selectFrom('external_slot_blocks')
      .selectAll()
      .where('integration_account_id', '=', p.integrationAccountId)
      .where('appointment_id', '=', p.appointmentId)
      .executeTakeFirst();
    const linkedHere = await ctx.trx
      .selectFrom('external_bookings')
      .select('id')
      .where('integration_account_id', '=', p.integrationAccountId)
      .where('appointment_id', '=', p.appointmentId)
      .where('sync_state', '=', 'synced')
      .executeTakeFirst();
    return { acc, appt, block, linkedHere: !!linkedHere };
  });
  const { acc, appt, block } = loaded;
  if (!acc || !appt) return;
  const adapter = getAdapter(acc.provider);
  if (!adapter) return;
  const cfg = parseIntegrationConfig(acc.config);
  const key = { integrationAccountId: acc.id, appointmentId: appt.id };

  const active = !appt.deleted_at && (ACTIVE_STATUSES as readonly string[]).includes(appt.status);
  const want = acc.status !== 'disabled' && cfg.pushBlocks && active && !loaded.linkedHere && appt.shop_id === acc.shop_id;
  const staffExternalId = appt.staff_id ? (Object.entries(cfg.staffMap).find(([, v]) => v === appt.staff_id)?.[0] ?? null) : null;
  const present = !!block?.external_block_id;

  if (adapter.pushMode === 'manual') {
    // no write API on this medium (e.g. SALON BOARD / LiME): staff task instead of an API call
    await reconcileManualBlock(jc, acc, appt, block, want);
    return;
  }
  if (want && !staffExternalId && !present) {
    await jc.tx((ctx) => upsertBlock(ctx, key, { state: 'error', last_error: 'スタッフ対応表に未登録のスタッフのため外部枠へ反映できません' }));
    return;
  }
  const same =
    present &&
    block!.block_start_at?.getTime() === appt.occupied_start_at.getTime() &&
    block!.block_end_at?.getTime() === appt.occupied_end_at.getTime() &&
    block!.staff_external_id === staffExternalId;
  if (want && same) {
    if (block!.state !== 'pushed') await jc.tx((ctx) => upsertBlock(ctx, key, { state: 'pushed', last_error: null }));
    return;
  }
  if (!want && !present) {
    if (block && block.state !== 'removed') await jc.tx((ctx) => upsertBlock(ctx, key, { state: 'removed', last_error: null }));
    return;
  }
  if (acc.status === 'degraded') {
    // 縮退運転: provider is down — park and reconcile after recovery
    await jc.tx((ctx) => upsertBlock(ctx, key, { state: 'pending', last_error: '外部連携が縮退中のため保留中' }));
    return;
  }

  const account = toAdapterAccount(acc);
  try {
    if (present) {
      await adapter.removeBlock(account, block!.external_block_id!);
      await jc.tx((ctx) => upsertBlock(ctx, key, { state: 'removed', external_block_id: null, last_error: null }));
    }
    if (want) {
      const externalBlockId = await adapter.pushBlock(account, { appointmentId: appt.id, staffExternalId, start: appt.occupied_start_at, end: appt.occupied_end_at });
      await jc.tx((ctx) =>
        upsertBlock(ctx, key, {
          state: 'pushed',
          external_block_id: externalBlockId,
          last_error: null,
          block_start_at: appt.occupied_start_at,
          block_end_at: appt.occupied_end_at,
          staff_external_id: staffExternalId,
          pushed_at: new Date(),
          attempts: jc.job.attempts,
        }),
      );
    }
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    const final = jc.job.attempts >= jc.job.max_attempts;
    await jc.tx(async (ctx) => {
      await upsertBlock(ctx, key, { state: 'error', last_error: message, attempts: jc.job.attempts });
      if (final) {
        await recordConflict(ctx, {
          type: 'push_failed',
          appointmentId: appt.id,
          details: { integrationAccountId: acc.id, provider: acc.provider, shopId: acc.shop_id, appointmentId: appt.id, operation: want ? 'push' : 'remove', error: message, attempts: jc.job.attempts },
        });
      }
    });
    throw err;
  }
});
