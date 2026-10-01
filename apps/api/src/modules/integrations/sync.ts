import { sql } from 'kysely';
import type { Ctx } from '../../auth/actor.js';
import { withSystem, type Tx } from '../../db/tenant.js';
import { enqueue, PermanentJobError, registerJob, type JobContext } from '../../jobs/queue.js';
import { everyMinutes, registerPeriodic } from '../../jobs/scheduler.js';
import { sha256 } from '../../lib/crypto.js';
import { AppError, fromPgError } from '../../lib/errors.js';
import { emit } from '../../lib/events.js';
import { isFeatureEnabledFor } from '../../lib/feature-flags.js';
import { addDays, addMinutes } from '../../lib/time.js';
import { ACTIVE_STATUSES, createAppointment, transitionAppointment, updateAppointment } from '../appointments/service.js';
import { resolveCustomer } from '../customers/identity.js';
import { loadAccountRow, toAdapterAccount } from './accounts.js';
import { getAdapter } from './adapters/registry.js';
import { AdapterError, type AdapterAccount, type ConflictPolicy, type ExternalBooking } from './adapters/types.js';
import { recordConflict } from './conflict-store.js';
import { enqueuePushJob, replayPendingBlocks } from './push.js';

/**
 * Sync engine (FR-06 / 要件 6.3, 9.1, 12): external → internal.
 *  - one sync_jobs row per attempt (running → succeeded / failed / dead) with stats
 *  - each normalized booking is applied in its own transaction (a bad record never aborts the batch)
 *  - external_bookings keeps external id / status / raw payload / payload_hash (unchanged → skipped)
 *  - the cursor advances only after the whole batch was processed successfully
 *  - adapter failures → queue retry with exponential backoff; 3 consecutive failures → degraded
 */
export const SYNC_JOB = 'integration.sync';
export const SYNC_MAX_ATTEMPTS = 5;
export const DEGRADED_THRESHOLD = 3;

export type SyncMode = 'delta' | 'full';
export type SyncTrigger = 'schedule' | 'manual' | 'webhook';

export interface SyncPayload {
  integrationAccountId: string;
  mode: SyncMode;
  triggeredBy: SyncTrigger;
}

export interface SyncStats {
  fetched: number;
  created: number;
  updated: number;
  cancelled: number;
  conflicts: number;
  skipped: number;
  linked: number;
  errors: number;
}

export const emptyStats = (): SyncStats => ({ fetched: 0, created: 0, updated: 0, cancelled: 0, conflicts: 0, skipped: 0, linked: 0, errors: 0 });

const OVERLAP_CODES = new Set(['SLOT_UNAVAILABLE', 'APPOINTMENT_OVERLAP', 'RESOURCE_OVERLAP']);
const EDITABLE = ['tentative', 'confirmed', 'checked_in'];
const CANCEL_REASON_EXTERNAL = '外部予約媒体でキャンセルされました';
const CANCEL_REASON_POLICY = '外部予約優先ルール(external_wins)により自動キャンセル';

// ------------------------------------------------------------------ helpers

let savepointSeq = 0;

/** Run fn inside a SAVEPOINT; AppErrors (incl. mapped PG errors) roll back to it and are returned */
async function attempt<T>(ctx: Ctx, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: AppError }> {
  const name = `intg_sp_${++savepointSeq}`;
  await sql.raw(`SAVEPOINT ${name}`).execute(ctx.trx);
  try {
    const value = await fn();
    await sql.raw(`RELEASE SAVEPOINT ${name}`).execute(ctx.trx);
    return { ok: true, value };
  } catch (err) {
    await sql.raw(`ROLLBACK TO SAVEPOINT ${name}`).execute(ctx.trx);
    const appErr = err instanceof AppError ? err : fromPgError(err);
    if (appErr) return { ok: false, error: appErr };
    throw err;
  }
}

function normalizedJson(nb: ExternalBooking) {
  return {
    externalId: nb.externalId,
    status: nb.status,
    start: nb.start.toISOString(),
    end: nb.end.toISOString(),
    staffExternalId: nb.staffExternalId,
    menuExternalIds: nb.menuExternalIds,
    customer: nb.customer,
    note: nb.note,
    updatedAt: nb.updatedAt.toISOString(),
  };
}

export function bookingFromNormalized(n: ReturnType<typeof normalizedJson>, raw: unknown): ExternalBooking {
  return {
    externalId: n.externalId,
    status: n.status,
    start: new Date(n.start),
    end: new Date(n.end),
    staffExternalId: n.staffExternalId,
    menuExternalIds: n.menuExternalIds,
    customer: n.customer,
    note: n.note,
    updatedAt: new Date(n.updatedAt),
    raw,
  };
}

export function payloadHash(nb: ExternalBooking): string {
  return sha256(JSON.stringify(normalizedJson(nb)));
}

function splitName(full: string | null): [string, string] {
  if (!full) return ['', ''];
  const parts = full.trim().split(/[\s\u3000]+/).filter(Boolean);
  return [parts[0] ?? '', parts.slice(1).join(' ')];
}

type ExtRow = { id: string; appointment_id: string | null; sync_state: string; payload_hash: string; external_updated_at: Date | null };

async function setExternalState(ctx: Ctx, extId: string, patch: { sync_state: string; appointment_id?: string | null; last_error?: string | null; payload_hash?: string }) {
  await ctx.trx
    .updateTable('external_bookings')
    .set({ ...patch, last_error: patch.last_error ?? null, last_synced_at: new Date() })
    .where('id', '=', extId)
    .execute();
}

/** Close open conflicts of a booking (it was applied successfully or cancelled on the medium) */
async function closeOpenConflicts(ctx: Ctx, extId: string, state: 'resolved' | 'ignored', resolution: string) {
  await ctx.trx
    .updateTable('sync_conflicts')
    .set({ state, resolution, resolved_at: new Date() })
    .where('external_booking_id', '=', extId)
    .where('state', '=', 'open')
    .where('conflict_type', '!=', 'push_failed')
    .execute();
}

async function resolveExternalCustomer(ctx: Ctx, account: AdapterAccount, nb: ExternalBooking): Promise<string | null> {
  const c = nb.customer;
  if (!c.name && !c.kana && !c.phone && !c.email && !c.externalMemberId) return null;
  const [lastName, firstName] = splitName(c.name);
  const [lastNameKana, firstNameKana] = splitName(c.kana);
  const res = await resolveCustomer(ctx, {
    provider: account.provider,
    providerAccountId: account.id,
    externalId: c.externalMemberId ?? undefined,
    displayName: c.name ?? undefined,
    lastName: lastName || undefined,
    firstName,
    lastNameKana,
    firstNameKana,
    phone: c.phone,
    email: c.email,
    shopId: account.shopId,
    acquisitionSource: account.provider,
  });
  return res.customerId;
}

/** Internal appointments of the staff whose occupied range intersects the external booking */
async function findClashes(ctx: Ctx, staffId: string | null, menuIds: string[], nb: ExternalBooking, excludeId?: string | null) {
  if (!staffId) return [];
  const menus = menuIds.length
    ? await ctx.trx.selectFrom('menus').select(['id', 'duration_min', 'buffer_before_min', 'buffer_after_min']).where('id', 'in', menuIds).execute()
    : [];
  const ordered = menuIds.map((id) => menus.find((m) => m.id === id)).filter(Boolean) as typeof menus;
  const duration = ordered.reduce((s, m) => s + m.duration_min, 0);
  const from = addMinutes(nb.start, -(ordered[0]?.buffer_before_min ?? 0));
  const planEnd = addMinutes(nb.start, duration + (ordered[ordered.length - 1]?.buffer_after_min ?? 0));
  const to = planEnd > nb.end ? planEnd : nb.end;
  return ctx.trx
    .selectFrom('appointments')
    .select(['id', 'status', 'start_at', 'source'])
    .where('staff_id', '=', staffId)
    .where('status', 'in', [...ACTIVE_STATUSES])
    .where('deleted_at', 'is', null)
    .where('occupied_start_at', '<', to)
    .where('occupied_end_at', '>', from)
    .$if(!!excludeId, (q) => q.where('id', '!=', excludeId!))
    .execute();
}

// ------------------------------------------------------------------ apply one booking

export type ApplyOutcome = 'created' | 'updated' | 'cancelled' | 'linked' | 'conflict' | 'skipped' | 'error';

export interface ApplyOptions {
  /** override the account's conflict policy (conflict resolution: accept_external) */
  policy?: ConflictPolicy;
  /** re-apply even when the payload is unchanged */
  force?: boolean;
}

/**
 * Upsert the external booking record and reflect it to the internal calendar.
 * Runs inside the caller's (per-booking) transaction.
 */
export async function processExternalBooking(ctx: Ctx, account: AdapterAccount, nb: ExternalBooking, stats: SyncStats, opts: ApplyOptions = {}): Promise<ApplyOutcome> {
  const hash = payloadHash(nb);
  const existing = (await ctx.trx
    .selectFrom('external_bookings')
    .select(['id', 'appointment_id', 'sync_state', 'payload_hash', 'external_updated_at'])
    .where('integration_account_id', '=', account.id)
    .where('external_booking_id', '=', nb.externalId)
    .forUpdate()
    .executeTakeFirst()) as ExtRow | undefined;

  if (existing && !opts.force) {
    if (existing.payload_hash === hash) {
      stats.skipped++;
      return 'skipped';
    }
    if (existing.external_updated_at && nb.updatedAt < existing.external_updated_at) {
      // out-of-order delivery: an older version must never overwrite a newer one
      stats.skipped++;
      return 'skipped';
    }
  }

  const values = {
    raw_payload: JSON.stringify(nb.raw ?? null),
    normalized: JSON.stringify(normalizedJson(nb)),
    payload_hash: hash,
    external_status: nb.status,
    external_updated_at: nb.updatedAt,
  };
  let ext: ExtRow;
  if (existing) {
    await ctx.trx.updateTable('external_bookings').set({ ...values, sync_state: 'pending', last_error: null }).where('id', '=', existing.id).execute();
    ext = { ...existing, payload_hash: hash, external_updated_at: nb.updatedAt };
  } else {
    ext = (await ctx.trx
      .insertInto('external_bookings')
      .values({ ...values, organization_id: ctx.actor.organizationId, integration_account_id: account.id, provider: account.provider, external_booking_id: nb.externalId, sync_state: 'pending' })
      .returning(['id', 'appointment_id', 'sync_state', 'payload_hash', 'external_updated_at'])
      .executeTakeFirstOrThrow()) as ExtRow;
  }
  return applyExternalBooking(ctx, account, ext, nb, stats, opts.policy ?? account.config.conflictPolicy);
}

export async function applyExternalBooking(ctx: Ctx, account: AdapterAccount, ext: ExtRow, nb: ExternalBooking, stats: SyncStats, policy: ConflictPolicy): Promise<ApplyOutcome> {
  const shopId = account.shopId;
  const base = { integrationAccountId: account.id, provider: account.provider, shopId, externalBookingId: nb.externalId, startAt: nb.start.toISOString(), endAt: nb.end.toISOString() };
  if (!shopId) {
    await setExternalState(ctx, ext.id, { sync_state: 'error', last_error: '連携アカウントに店舗が設定されていません', payload_hash: '' });
    stats.errors++;
    return 'error';
  }

  // ---- cancellation on the medium
  if (nb.status === 'cancelled') {
    await closeOpenConflicts(ctx, ext.id, 'ignored', 'external_cancelled');
    if (ext.appointment_id) {
      const appt = await ctx.trx.selectFrom('appointments').select(['id', 'status']).where('id', '=', ext.appointment_id).where('deleted_at', 'is', null).executeTakeFirst();
      if (appt && EDITABLE.includes(appt.status)) {
        await transitionAppointment(ctx, appt.id, 'cancelled', { trusted: true, cancelledBy: 'external', reason: CANCEL_REASON_EXTERNAL });
        await setExternalState(ctx, ext.id, { sync_state: 'synced' });
        stats.cancelled++;
        return 'cancelled';
      }
      await setExternalState(ctx, ext.id, { sync_state: 'synced' });
      stats.skipped++;
      return 'skipped';
    }
    await setExternalState(ctx, ext.id, { sync_state: 'ignored' });
    stats.skipped++;
    return 'skipped';
  }

  // ---- mapping (staff / menus)
  const staffId = nb.staffExternalId ? (account.config.staffMap[nb.staffExternalId] ?? null) : null;
  if (nb.staffExternalId && !staffId) {
    await recordConflict(ctx, { type: 'unknown_staff', externalBookingId: ext.id, details: { ...base, staffExternalId: nb.staffExternalId } });
    await setExternalState(ctx, ext.id, { sync_state: 'conflict', last_error: `スタッフ対応表に未登録の外部スタッフです (${nb.staffExternalId})`, payload_hash: '' });
    stats.conflicts++;
    return 'conflict';
  }
  const unknownMenus = nb.menuExternalIds.filter((m) => !account.config.menuMap[m]);
  if (!nb.menuExternalIds.length || unknownMenus.length) {
    await recordConflict(ctx, { type: 'unknown_menu', externalBookingId: ext.id, details: { ...base, menuExternalIds: unknownMenus.length ? unknownMenus : nb.menuExternalIds } });
    await setExternalState(ctx, ext.id, {
      sync_state: 'conflict',
      last_error: unknownMenus.length ? `メニュー対応表に未登録の外部メニューです (${unknownMenus.join(', ')})` : 'メニューが指定されていません',
      payload_hash: '',
    });
    stats.conflicts++;
    return 'conflict';
  }
  const menuIds = nb.menuExternalIds.map((m) => account.config.menuMap[m]!);
  const customerId = await resolveExternalCustomer(ctx, account, nb);
  const details = { ...base, staffId, menuIds, customerId };

  // ---- already linked → update
  if (ext.appointment_id) {
    const appt = await ctx.trx
      .selectFrom('appointments')
      .select(['id', 'status', 'start_at', 'staff_id', 'version', 'customer_id', 'customer_note'])
      .where('id', '=', ext.appointment_id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (appt && ['in_service', 'completed'].includes(appt.status)) {
      await setExternalState(ctx, ext.id, { sync_state: 'synced' });
      stats.skipped++;
      return 'skipped';
    }
    if (appt && EDITABLE.includes(appt.status)) {
      const current = await ctx.trx.selectFrom('appointment_services').select('menu_id').where('appointment_id', '=', appt.id).orderBy('sort_order').execute();
      const sameMenus = current.length === menuIds.length && current.every((s, i) => s.menu_id === menuIds[i]);
      const scheduleChanged = appt.start_at.getTime() !== nb.start.getTime() || (!!staffId && staffId !== appt.staff_id) || !sameMenus;
      const customerChanged = !!customerId && customerId !== appt.customer_id;
      const noteChanged = (nb.note ?? null) !== (appt.customer_note ?? null);
      if (!scheduleChanged && !customerChanged && !noteChanged) {
        await closeOpenConflicts(ctx, ext.id, 'resolved', 'auto_resolved');
        await setExternalState(ctx, ext.id, { sync_state: 'synced' });
        stats.skipped++;
        return 'skipped';
      }
      const doUpdate = async () => {
        const fresh = await ctx.trx.selectFrom('appointments').select('version').where('id', '=', appt.id).executeTakeFirstOrThrow();
        return updateAppointment(
          ctx,
          appt.id,
          {
            version: fresh.version,
            startAt: nb.start.toISOString(),
            ...(staffId ? { staffId } : {}),
            menuIds,
            ...(customerChanged ? { customerId } : {}),
            customerNote: nb.note,
            allowOutsideSchedule: true,
          },
          { trusted: true },
        );
      };
      const r = await attempt(ctx, doUpdate);
      if (r.ok) {
        await closeOpenConflicts(ctx, ext.id, 'resolved', 'auto_resolved');
        await setExternalState(ctx, ext.id, { sync_state: 'synced' });
        stats.updated++;
        return 'updated';
      }
      if (OVERLAP_CODES.has(r.error.code)) {
        return handleOverlap(ctx, { ext, nb, staffId, menuIds, policy, stats, details: { ...details, op: 'update', appointmentId: appt.id }, excludeId: appt.id, retry: doUpdate, kind: 'updated' });
      }
      await setExternalState(ctx, ext.id, { sync_state: 'error', last_error: r.error.message, payload_hash: '' });
      stats.errors++;
      return 'error';
    }
    // linked appointment was cancelled/deleted internally while still booked on the medium → book again
    await ctx.trx.updateTable('external_bookings').set({ appointment_id: null }).where('id', '=', ext.id).execute();
    ext = { ...ext, appointment_id: null };
  }

  // ---- duplicate: same customer already booked at the same start (e.g. phone booking typed in by staff)
  if (customerId) {
    const dup = await ctx.trx
      .selectFrom('appointments')
      .select(['id'])
      .where('shop_id', '=', shopId)
      .where('customer_id', '=', customerId)
      .where('start_at', '=', nb.start)
      .where('status', 'in', [...ACTIVE_STATUSES])
      .where('deleted_at', 'is', null)
      .where((eb) => eb.not(eb.exists(eb.selectFrom('external_bookings as eb2').select(sql`1`.as('x')).whereRef('eb2.appointment_id', '=', 'appointments.id'))))
      .executeTakeFirst();
    if (dup) {
      await setExternalState(ctx, ext.id, { sync_state: 'synced', appointment_id: dup.id });
      await closeOpenConflicts(ctx, ext.id, 'resolved', 'auto_resolved');
      await recordConflict(ctx, { type: 'duplicate', externalBookingId: ext.id, appointmentId: dup.id, details: { ...details, linkedAppointmentId: dup.id }, state: 'resolved', resolution: 'merged' });
      // the slot is now held by the medium's own booking → an earlier pushed block is redundant
      await enqueuePushJob(ctx, account.id, dup.id, 'linked');
      stats.linked++;
      return 'linked';
    }
  }

  // ---- create
  const doCreate = () =>
    createAppointment(
      ctx,
      {
        shopId,
        customerId,
        staffId,
        startAt: nb.start.toISOString(),
        menuIds,
        source: 'external',
        sourceDetail: { provider: account.provider, externalBookingId: nb.externalId, integrationAccountId: account.id },
        customerNote: nb.note,
        status: 'confirmed',
        allowOutsideSchedule: true,
      },
      { trusted: true },
    );
  const r = await attempt(ctx, doCreate);
  if (r.ok) {
    await setExternalState(ctx, ext.id, { sync_state: 'synced', appointment_id: r.value.id });
    await closeOpenConflicts(ctx, ext.id, 'resolved', 'auto_resolved');
    stats.created++;
    return 'created';
  }
  if (OVERLAP_CODES.has(r.error.code)) {
    return handleOverlap(ctx, { ext, nb, staffId, menuIds, policy, stats, details: { ...details, op: 'create' }, excludeId: null, retry: doCreate, kind: 'created' });
  }
  await setExternalState(ctx, ext.id, { sync_state: 'error', last_error: r.error.message, payload_hash: '' });
  stats.errors++;
  return 'error';
}

interface OverlapInput {
  ext: ExtRow;
  nb: ExternalBooking;
  staffId: string | null;
  menuIds: string[];
  policy: ConflictPolicy;
  stats: SyncStats;
  details: Record<string, unknown>;
  excludeId: string | null;
  retry: () => Promise<{ id: string }>;
  kind: 'created' | 'updated';
}

/** Priority rules for double booking (要件 12): manual queue / internal wins / external wins */
async function handleOverlap(ctx: Ctx, o: OverlapInput): Promise<ApplyOutcome> {
  const clashes = await findClashes(ctx, o.staffId, o.menuIds, o.nb, o.excludeId);
  const details = { ...o.details, clashingAppointmentIds: clashes.map((c) => c.id), policy: o.policy };
  const message = '内部予約と時間が重複しています';

  if (o.policy === 'external_wins' && clashes.length) {
    const cancellable = clashes.every((c) => EDITABLE.includes(c.status));
    if (cancellable) {
      const r = await attempt(ctx, async () => {
        for (const c of clashes) {
          await transitionAppointment(ctx, c.id, 'cancelled', { trusted: true, cancelledBy: 'system', reason: CANCEL_REASON_POLICY });
        }
        return o.retry();
      });
      if (r.ok) {
        await setExternalState(ctx, o.ext.id, { sync_state: 'synced', appointment_id: r.value.id });
        await closeOpenConflicts(ctx, o.ext.id, 'resolved', 'accept_external');
        await recordConflict(ctx, {
          type: 'overlap',
          externalBookingId: o.ext.id,
          appointmentId: r.value.id,
          details: { ...details, cancelledAppointmentIds: clashes.map((c) => c.id) },
          state: 'resolved',
          resolution: 'accept_external',
        });
        o.stats.conflicts++;
        o.stats[o.kind]++;
        return o.kind;
      }
      (details as Record<string, unknown>).autoResolveError = r.error.message;
    } else {
      (details as Record<string, unknown>).autoResolveError = '施術中/完了済みの予約は自動キャンセルできません';
    }
  }

  if (o.policy === 'internal_wins') {
    // internal booking keeps the slot; the external booking stays unmapped (recorded for follow-up with the medium)
    await recordConflict(ctx, { type: 'overlap', externalBookingId: o.ext.id, appointmentId: clashes[0]?.id ?? null, details, state: 'resolved', resolution: 'keep_internal' });
    await setExternalState(ctx, o.ext.id, { sync_state: 'conflict', last_error: `${message}（内部優先ルールにより未反映）` });
    o.stats.conflicts++;
    return 'conflict';
  }

  await recordConflict(ctx, { type: 'overlap', externalBookingId: o.ext.id, appointmentId: clashes[0]?.id ?? null, details });
  await setExternalState(ctx, o.ext.id, { sync_state: 'conflict', last_error: `${message}（手動解決待ち）` });
  o.stats.conflicts++;
  return 'conflict';
}

/** Persist a booking that failed unexpectedly (its transaction was rolled back) */
async function recordBookingError(ctx: Ctx, account: AdapterAccount, nb: ExternalBooking, message: string) {
  await ctx.trx
    .insertInto('external_bookings')
    .values({
      organization_id: ctx.actor.organizationId,
      integration_account_id: account.id,
      provider: account.provider,
      external_booking_id: nb.externalId,
      external_status: nb.status,
      raw_payload: JSON.stringify(nb.raw ?? null),
      normalized: JSON.stringify(normalizedJson(nb)),
      payload_hash: '',
      external_updated_at: nb.updatedAt,
      sync_state: 'error',
      last_error: message.slice(0, 2000),
    })
    .onConflict((oc) => oc.columns(['integration_account_id', 'external_booking_id']).doUpdateSet({ sync_state: 'error', last_error: message.slice(0, 2000), payload_hash: '' }))
    .execute();
}

// ------------------------------------------------------------------ job

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function recordSyncFailure(ctx: Ctx, accountId: string, syncJobId: string, err: unknown, final: boolean) {
  const row = await loadAccountRow(ctx.trx, accountId, { forUpdate: true });
  if (!row) return;
  const failures = row.consecutive_failures + 1;
  const message = errorMessage(err).slice(0, 2000);
  await ctx.trx.updateTable('sync_jobs').set({ state: final ? 'dead' : 'failed', error: message, finished_at: new Date() }).where('id', '=', syncJobId).execute();
  const degraded = failures >= DEGRADED_THRESHOLD;
  await ctx.trx
    .updateTable('integration_accounts')
    .set({
      consecutive_failures: failures,
      last_error: message,
      last_error_at: new Date(),
      last_synced_at: new Date(),
      status: row.status === 'disabled' ? 'disabled' : degraded ? 'degraded' : row.status === 'degraded' ? 'degraded' : 'error',
    })
    .where('id', '=', accountId)
    .execute();
  if (degraded && row.status !== 'degraded' && row.status !== 'disabled') {
    // 縮退運転: internal booking continues, pushes are parked until recovery
    await emit(ctx, {
      type: 'integration.degraded',
      aggregateType: 'integration_account',
      aggregateId: accountId,
      payload: { integrationAccountId: accountId, provider: row.provider, shopId: row.shop_id, consecutiveFailures: failures, lastError: message },
    });
  }
}

async function recordSyncSuccess(ctx: Ctx, accountId: string, syncJobId: string, nextCursor: string | null, stats: SyncStats) {
  const row = await loadAccountRow(ctx.trx, accountId, { forUpdate: true });
  if (!row) return;
  const now = new Date();
  await ctx.trx
    .updateTable('sync_jobs')
    .set({ state: 'succeeded', stats: JSON.stringify(stats), cursor_after: nextCursor ?? row.sync_cursor, finished_at: now })
    .where('id', '=', syncJobId)
    .execute();
  await ctx.trx
    .updateTable('integration_accounts')
    .set({
      sync_cursor: nextCursor ?? row.sync_cursor,
      last_synced_at: now,
      last_success_at: now,
      consecutive_failures: 0,
      status: row.status === 'disabled' ? 'disabled' : 'active',
    })
    .where('id', '=', accountId)
    .execute();
  if (row.status === 'degraded') {
    await emit(ctx, {
      type: 'integration.recovered',
      aggregateType: 'integration_account',
      aggregateId: accountId,
      payload: { integrationAccountId: accountId, provider: row.provider, shopId: row.shop_id },
    });
    await replayPendingBlocks(ctx, accountId);
  }
}

/** Range used by 全件再同期 */
export function fullSyncRange(now = new Date()) {
  return { from: addDays(now, -1), to: addDays(now, 180) };
}

export async function runSync(payload: SyncPayload, jc: JobContext): Promise<SyncStats | null> {
  const row = await jc.tx((ctx) => loadAccountRow(ctx.trx, payload.integrationAccountId));
  if (!row || row.status === 'disabled') return null;
  const adapter = getAdapter(row.provider);
  if (!adapter) throw new PermanentJobError(`adapter not registered: ${row.provider}`);
  const account = toAdapterAccount(row);

  const syncJobId = await jc.tx(async (ctx) => {
    const created = await ctx.trx
      .insertInto('sync_jobs')
      .values({
        organization_id: ctx.actor.organizationId,
        integration_account_id: row.id,
        provider: row.provider,
        resource: 'bookings',
        mode: payload.mode,
        state: 'running',
        cursor_before: row.sync_cursor,
        retry_count: Math.max(0, jc.job.attempts - 1),
        triggered_by: payload.triggeredBy,
        started_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return created.id;
  });

  let fetched;
  try {
    fetched = payload.mode === 'full' ? await adapter.fetchAll(account, fullSyncRange()) : await adapter.fetchChanges(account, row.sync_cursor);
  } catch (err) {
    const permanent = err instanceof AdapterError && err.permanent;
    await jc.tx((ctx) => recordSyncFailure(ctx, row.id, syncJobId, err, permanent || jc.job.attempts >= jc.job.max_attempts));
    if (permanent) throw new PermanentJobError(errorMessage(err));
    throw err;
  }

  const stats = emptyStats();
  stats.fetched = fetched.bookings.length;
  for (const nb of fetched.bookings) {
    try {
      await jc.tx((ctx) => processExternalBooking(ctx, account, nb, stats));
    } catch (err) {
      stats.errors++;
      await jc.tx((ctx) => recordBookingError(ctx, account, nb, errorMessage(err))).catch(() => undefined);
    }
  }
  await jc.tx((ctx) => recordSyncSuccess(ctx, row.id, syncJobId, fetched.nextCursor, stats));
  return stats;
}

registerJob<SyncPayload>(SYNC_JOB, async (payload, jc) => {
  await runSync(payload, jc);
});

/** Enqueue a sync for an account (manual resync / webhook / schedule) */
export async function enqueueSync(trxOrCtx: Tx | Ctx, account: { id: string; organizationId: string }, mode: SyncMode, triggeredBy: SyncTrigger, dedupeKey: string): Promise<string | null> {
  return enqueue(trxOrCtx, {
    type: SYNC_JOB,
    organizationId: account.organizationId,
    payload: { integrationAccountId: account.id, mode, triggeredBy } satisfies SyncPayload,
    dedupeKey,
    maxAttempts: SYNC_MAX_ATTEMPTS,
    priority: triggeredBy === 'schedule' ? 0 : 5,
  });
}

// ------------------------------------------------------------------ periodic delta (fan-out per account)

export const DELTA_FANOUT_JOB = 'integrations.delta_fanout';

export async function fanOutDeltaSync(now = new Date()): Promise<number> {
  const bucket = Math.floor(now.getTime() / (5 * 60_000));
  return withSystem(async (trx) => {
    const accounts = await trx.selectFrom('integration_accounts').select(['id', 'organization_id', 'provider']).where('status', '!=', 'disabled').where('shop_id', 'is not', null).execute();
    let n = 0;
    for (const a of accounts) {
      const adapter = getAdapter(a.provider);
      // e-mail connectors are push-only (inbound webhook); nothing to poll
      if (!adapter || adapter.inboundEmail) continue;
      if (!(await isFeatureEnabledFor(trx, a.organization_id, 'external_sync', true))) continue;
      const id = await enqueueSync(trx, { id: a.id, organizationId: a.organization_id }, 'delta', 'schedule', `intg-sync:${a.id}:delta:${bucket}`);
      if (id) n++;
    }
    return n;
  });
}

registerJob(DELTA_FANOUT_JOB, async () => {
  await fanOutDeltaSync();
});

registerPeriodic({ name: 'integrations.delta', jobType: DELTA_FANOUT_JOB, bucket: everyMinutes(5) });
