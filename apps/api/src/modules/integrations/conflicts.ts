import { sql } from 'kysely';
import { accessibleShopIds, auditUserId, hasShopAccess, requireAnyPermission, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { getVisibleAccount, loadAccountRow, parseIntegrationConfig, toAdapterAccount } from './accounts.js';
import { enqueuePushJob } from './push.js';
import type { ListConflictsInput, ResolveConflictInput } from './schemas.js';
import { applyExternalBooking, bookingFromNormalized, emptyStats, enqueueSync, type SyncMode } from './sync.js';

/** account id of a conflict: via its external booking, or recorded in details (push_failed) */
const conflictAccountId = sql<string>`coalesce(eb.integration_account_id, (sc.details->>'integrationAccountId')::uuid)`;

function shopFilterIds(ctx: Ctx): string[] | null {
  const shops = accessibleShopIds(ctx.actor);
  if (!shops) return null;
  return shops.length ? [...shops] : ['00000000-0000-0000-0000-000000000000'];
}

function conflictQuery(ctx: Ctx) {
  return ctx.trx
    .selectFrom('sync_conflicts as sc')
    .leftJoin('external_bookings as eb', 'eb.id', 'sc.external_booking_id')
    .leftJoin('integration_accounts as ia', (j) => j.on(sql`ia.id`, '=', conflictAccountId))
    .select([
      'sc.id',
      'sc.conflict_type',
      'sc.state',
      'sc.resolution',
      'sc.details',
      'sc.appointment_id',
      'sc.external_booking_id',
      'sc.resolved_by',
      'sc.resolved_at',
      'sc.created_at',
      'eb.external_booking_id as external_id',
      'eb.external_status',
      'eb.sync_state as external_sync_state',
      'eb.normalized as external_booking',
      'ia.id as integration_account_id',
      'ia.provider',
      'ia.display_name as integration_name',
      'ia.shop_id',
    ]);
}

export async function listConflicts(ctx: Ctx, input: ListConflictsInput) {
  requirePermission(ctx.actor, 'integration.manage');
  let q = conflictQuery(ctx);
  const shops = shopFilterIds(ctx);
  if (shops) q = q.where('ia.shop_id', 'in', shops);
  if (input.state) q = q.where('sc.state', '=', input.state);
  if (input.type) q = q.where('sc.conflict_type', '=', input.type);
  if (input.integrationAccountId) q = q.where(conflictAccountId, '=', input.integrationAccountId);
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql`(sc.created_at, sc.id)`, '<', sql`(${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('sc.created_at', 'desc').orderBy('sc.id', 'desc').limit(input.limit + 1).execute();
  return paginate(rows, input.limit, (r) => r.created_at);
}

export async function getConflict(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'integration.manage');
  const row = await conflictQuery(ctx).where('sc.id', '=', id).executeTakeFirst();
  if (!row || !hasShopAccess(ctx.actor, row.shop_id)) throw Errors.notFound('同期競合', id);
  return row;
}

/**
 * Manual resolution queue (要件 12):
 *  - keep_internal: internal booking stays; the external booking is left unmapped (follow up on the medium)
 *  - accept_external: re-apply the external booking now with external-wins semantics (cancels clashing
 *    internal bookings); for unknown staff/menu this re-applies with the current mapping; for push_failed it retries the push
 *  - ignore: close without action
 *  - manual: staff handled it by hand (optionally link the external booking to an appointment)
 */
export async function resolveConflict(ctx: Ctx, id: string, input: ResolveConflictInput) {
  requirePermission(ctx.actor, 'integration.manage');
  const conflict = await getConflict(ctx, id);
  await ctx.trx.selectFrom('sync_conflicts').select('id').where('id', '=', id).forUpdate().executeTakeFirst();
  const fresh = await ctx.trx.selectFrom('sync_conflicts').select(['state', 'details']).where('id', '=', id).executeTakeFirstOrThrow();
  if (fresh.state !== 'open') throw Errors.business('CONFLICT_ALREADY_RESOLVED', 'この競合は既に解決済みです');
  if (!conflict.integration_account_id) throw Errors.business('CONFLICT_ORPHANED', '連携アカウントが見つかりません');
  const accountRow = (await loadAccountRow(ctx.trx, conflict.integration_account_id))!;

  const ext = conflict.external_booking_id
    ? await ctx.trx
        .selectFrom('external_bookings')
        .select(['id', 'appointment_id', 'sync_state', 'payload_hash', 'external_updated_at', 'normalized', 'raw_payload', 'external_status'])
        .where('id', '=', conflict.external_booking_id)
        .forUpdate()
        .executeTakeFirst()
    : undefined;

  let state: 'resolved' | 'ignored' = 'resolved';
  let linkedAppointmentId: string | null = conflict.appointment_id;
  const outcome: Record<string, unknown> = {};

  switch (input.resolution) {
    case 'accept_external': {
      if (conflict.conflict_type === 'push_failed') {
        if (!conflict.appointment_id) throw Errors.business('CONFLICT_ORPHANED', '対象の予約が見つかりません');
        await enqueuePushJob(ctx, accountRow.id, conflict.appointment_id, `retry-${id}`);
        outcome.pushRetried = true;
        break;
      }
      if (!ext) throw Errors.business('CONFLICT_ORPHANED', '外部予約が見つかりません');
      if (accountRow.status === 'disabled') throw Errors.business('INTEGRATION_DISABLED', '連携が無効化されています');
      const nb = bookingFromNormalized(ext.normalized as unknown as Parameters<typeof bookingFromNormalized>[0], ext.raw_payload);
      const stats = emptyStats();
      const result = await applyExternalBooking(ctx, toAdapterAccount(accountRow), ext, nb, stats, 'external_wins');
      if (result === 'conflict' || result === 'error') {
        const after = await ctx.trx.selectFrom('external_bookings').select(['last_error']).where('id', '=', ext.id).executeTakeFirst();
        // roll back everything this attempt did (incl. refreshed conflict rows)
        throw Errors.business('CONFLICT_UNRESOLVED', `外部予約を反映できませんでした: ${after?.last_error ?? '不明なエラー'}`, { outcome: result });
      }
      const linked = await ctx.trx.selectFrom('external_bookings').select('appointment_id').where('id', '=', ext.id).executeTakeFirst();
      linkedAppointmentId = linked?.appointment_id ?? linkedAppointmentId;
      outcome.result = result;
      outcome.stats = stats;
      break;
    }
    case 'keep_internal':
    case 'ignore': {
      if (input.resolution === 'ignore') state = 'ignored';
      if (ext && !ext.appointment_id) await ctx.trx.updateTable('external_bookings').set({ sync_state: 'ignored', last_synced_at: new Date() }).where('id', '=', ext.id).execute();
      break;
    }
    case 'manual': {
      if (input.appointmentId) {
        if (!ext) throw Errors.validation('外部予約に紐づかない競合には予約を指定できません');
        const appt = await ctx.trx.selectFrom('appointments').select(['id', 'shop_id']).where('id', '=', input.appointmentId).where('deleted_at', 'is', null).executeTakeFirst();
        if (!appt || appt.shop_id !== accountRow.shop_id) throw Errors.notFound('予約', input.appointmentId);
        const taken = await ctx.trx.selectFrom('external_bookings').select('id').where('appointment_id', '=', appt.id).where('id', '!=', ext.id).executeTakeFirst();
        if (taken) throw Errors.conflict('APPOINTMENT_ALREADY_LINKED', 'この予約は既に別の外部予約と紐づいています');
        await ctx.trx.updateTable('external_bookings').set({ appointment_id: appt.id, sync_state: 'synced', last_error: null, last_synced_at: new Date() }).where('id', '=', ext.id).execute();
        linkedAppointmentId = appt.id;
      }
      break;
    }
  }

  const details = { ...((fresh.details as Record<string, unknown>) ?? {}), resolutionNote: input.note ?? null, resolutionOutcome: outcome };
  await ctx.trx
    .updateTable('sync_conflicts')
    .set({ state, resolution: input.resolution, resolved_by: auditUserId(ctx.actor), resolved_at: new Date(), details: JSON.stringify(details), appointment_id: linkedAppointmentId })
    .where('id', '=', id)
    .execute();
  await audit(ctx, {
    action: 'sync_conflict.resolve',
    resourceType: 'sync_conflict',
    resourceId: id,
    shopId: accountRow.shop_id,
    before: { state: 'open' },
    after: { state, resolution: input.resolution, appointmentId: linkedAppointmentId },
    metadata: { conflictType: conflict.conflict_type, note: input.note ?? null },
  });
  return getConflict(ctx, id);
}

// ------------------------------------------------------------------ sync jobs / resync / status

export async function listSyncJobs(ctx: Ctx, accountId: string, input: { cursor?: string; limit: number }) {
  requirePermission(ctx.actor, 'integration.manage');
  await getVisibleAccount(ctx, accountId);
  let q = ctx.trx
    .selectFrom('sync_jobs')
    .select(['id', 'mode', 'resource', 'state', 'stats', 'error', 'retry_count', 'triggered_by', 'cursor_before', 'cursor_after', 'started_at', 'finished_at', 'created_at'])
    .where('integration_account_id', '=', accountId);
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql`(created_at, id)`, '<', sql`(${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(input.limit + 1).execute();
  return paginate(rows, input.limit, (r) => r.created_at);
}

/** 再同期ボタン: enqueue (or expedite an already queued) sync */
export async function requestResync(ctx: Ctx, accountId: string, mode: SyncMode) {
  requirePermission(ctx.actor, 'integration.manage');
  const row = await getVisibleAccount(ctx, accountId);
  if (row.status === 'disabled') throw Errors.business('INTEGRATION_DISABLED', '連携が無効化されています');
  const dedupeKey = `intg-sync:${row.id}:${mode}:manual`;
  let jobId = await enqueueSync(ctx, { id: row.id, organizationId: row.organization_id }, mode, 'manual', dedupeKey);
  if (!jobId) {
    const existing = await ctx.trx
      .updateTable('jobs')
      .set({ run_at: new Date() })
      .where('dedupe_key', '=', dedupeKey)
      .where('state', '=', 'queued')
      .returning('id')
      .executeTakeFirst();
    const running = existing ?? (await ctx.trx.selectFrom('jobs').select('id').where('dedupe_key', '=', dedupeKey).where('state', '=', 'running').executeTakeFirst());
    jobId = running?.id ?? null;
  }
  await audit(ctx, { action: 'integration.resync', resourceType: 'integration_account', resourceId: row.id, shopId: row.shop_id, metadata: { mode } });
  return { jobId, mode, queued: true };
}

/** 店舗向け同期ステータス: per shop, each account's last success / last error / degraded / open conflicts */
export async function syncStatus(ctx: Ctx, shopId?: string) {
  requireAnyPermission(ctx.actor, 'integration.manage', 'appointment.read');
  if (shopId && !hasShopAccess(ctx.actor, shopId)) throw Errors.forbidden('この店舗へのアクセス権がありません', 'SHOP_FORBIDDEN', { shopId });
  let q = ctx.trx
    .selectFrom('integration_accounts as ia')
    .leftJoin('shops', 'shops.id', 'ia.shop_id')
    .select([
      'ia.id',
      'ia.shop_id',
      'shops.name as shop_name',
      'ia.provider',
      'ia.display_name',
      'ia.status',
      'ia.config',
      'ia.last_success_at',
      'ia.last_synced_at',
      'ia.last_error',
      'ia.last_error_at',
      'ia.consecutive_failures',
    ])
    .where('ia.status', '!=', 'disabled')
    .orderBy('shops.name')
    .orderBy('ia.created_at');
  const shops = shopFilterIds(ctx);
  if (shops) q = q.where('ia.shop_id', 'in', shops);
  if (shopId) q = q.where('ia.shop_id', '=', shopId);
  const accounts = await q.execute();
  const ids = accounts.map((a) => a.id);
  const [conflicts, blocks, lastJobs] = ids.length
    ? await Promise.all([
        ctx.trx
          .selectFrom('sync_conflicts as sc')
          .leftJoin('external_bookings as eb', 'eb.id', 'sc.external_booking_id')
          .select([sql<string>`${conflictAccountId}::text`.as('account_id'), sql<number>`count(*)::int`.as('n')])
          .where('sc.state', '=', 'open')
          .where(conflictAccountId, 'in', ids)
          .groupBy(conflictAccountId)
          .execute(),
        ctx.trx
          .selectFrom('external_slot_blocks')
          .select(['integration_account_id', sql<number>`count(*)::int`.as('n')])
          .where('integration_account_id', 'in', ids)
          .where('state', 'in', ['pending', 'error'])
          .groupBy('integration_account_id')
          .execute(),
        ctx.trx
          .selectFrom('sync_jobs')
          .distinctOn('integration_account_id')
          .select(['integration_account_id', 'state', 'mode', 'stats', 'error', 'triggered_by', 'finished_at', 'created_at'])
          .where('integration_account_id', 'in', ids)
          .orderBy('integration_account_id')
          .orderBy('created_at', 'desc')
          .execute(),
      ])
    : [[], [], []];

  const byShop = new Map<string, { shopId: string | null; shopName: string | null; degraded: boolean; openConflicts: number; lastSuccessAt: Date | null; accounts: unknown[] }>();
  for (const a of accounts) {
    const key = a.shop_id ?? 'org';
    const entry = byShop.get(key) ?? { shopId: a.shop_id, shopName: a.shop_name, degraded: false, openConflicts: 0, lastSuccessAt: null, accounts: [] };
    const open = conflicts.find((c) => c.account_id === a.id)?.n ?? 0;
    const job = lastJobs.find((j) => j.integration_account_id === a.id) ?? null;
    entry.accounts.push({
      integrationAccountId: a.id,
      provider: a.provider,
      displayName: a.display_name,
      status: a.status,
      degraded: a.status === 'degraded',
      pushBlocks: parseIntegrationConfig(a.config).pushBlocks,
      lastSuccessAt: a.last_success_at,
      lastSyncedAt: a.last_synced_at,
      lastError: a.last_error,
      lastErrorAt: a.last_error_at,
      consecutiveFailures: a.consecutive_failures,
      openConflicts: open,
      unsyncedBlocks: blocks.find((b) => b.integration_account_id === a.id)?.n ?? 0,
      lastJob: job ? { state: job.state, mode: job.mode, triggeredBy: job.triggered_by, stats: job.stats, error: job.error, finishedAt: job.finished_at, createdAt: job.created_at } : null,
    });
    entry.degraded ||= a.status === 'degraded';
    entry.openConflicts += open;
    if (a.last_success_at && (!entry.lastSuccessAt || a.last_success_at < entry.lastSuccessAt)) entry.lastSuccessAt = a.last_success_at;
    byShop.set(key, entry);
  }
  return { shops: [...byShop.values()], checkedAt: new Date().toISOString() };
}
