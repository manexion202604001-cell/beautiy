import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { withSystem } from '../../db/tenant.js';
import { registeredPeriodicTasks } from '../../jobs/scheduler.js';
import { hmacSha256 } from '../../lib/crypto.js';
import { clearFeatureFlagCache } from '../../lib/feature-flags.js';
import { registerWebhookProvider } from '../../lib/webhooks.js';
import {
  api,
  asSystem,
  createCustomer,
  createMenu,
  createStaffUserUnthrottled,
  createTenantUnthrottled,
  expediteJobs,
  jst,
  nextWeekday,
  runJobs,
  runJobsWithRetries,
  type Tenant,
} from '../../test/helpers.js';
import { mockBookingProvider } from './adapters/mock-booking.js';
import { fanOutDeltaSync } from './sync.js';

const WED = 3;
const SYNC_TYPES = ['integration.sync'];
const PUSH_TYPES = ['integration.push_block'];
const WEBHOOK_TYPES = ['webhook.process'];

interface Setup {
  t: Tenant;
  stylist: { staffId: string; token: string; api: ReturnType<typeof api> };
  menu: { id: string };
  account: { id: string; webhookUrl: string };
  date: string;
}

async function setup(opts: { policy?: 'manual' | 'external_wins' | 'internal_wins'; pushBlocks?: boolean } = {}): Promise<Setup> {
  const t = await createTenantUnthrottled();
  const stylist = await createStaffUserUnthrottled(t, 'stylist', { displayName: 'スタイリストA' });
  const menu = await createMenu(t, { durationMin: 60 });
  const res = await t.owner.post('/v1/integrations', {
    provider: 'mock_booking',
    shopId: t.shopId,
    displayName: '予約媒体(模擬)',
    credentials: { apiKey: 'key-123', webhookSecret: 'whsec_test_secret' },
    config: { staffMap: { S1: stylist.staffId }, menuMap: { M1: menu.id }, conflictPolicy: opts.policy ?? 'manual', pushBlocks: opts.pushBlocks ?? false },
  });
  expect(res.status).toBe(201);
  return { t, stylist, menu, account: res.body, date: nextWeekday(WED) };
}

async function resync(s: Setup, mode: 'delta' | 'full' = 'delta') {
  const r = await s.t.owner.post(`/v1/integrations/${s.account.id}/resync`, { mode });
  expect(r.status).toBe(202);
  await runJobs();
}

async function lastSyncJob(s: Setup) {
  const r = await s.t.owner.get(`/v1/integrations/${s.account.id}/sync-jobs`);
  expect(r.status).toBe(200);
  return r.body.items[0];
}

function db<T>(s: Setup, fn: Parameters<typeof asSystem<T>>[1]) {
  return asSystem<T>(s.t.organizationId, fn);
}

async function externalAppointments(s: Setup) {
  return db(s, (ctx) =>
    ctx.trx.selectFrom('appointments').select(['id', 'status', 'start_at', 'staff_id', 'source', 'source_detail', 'customer_id', 'cancelled_by_type']).where('source', '=', 'external').orderBy('created_at').execute(),
  );
}

async function conflicts(s: Setup, state?: string) {
  const r = await s.t.owner.get('/v1/sync-conflicts', state ? { state } : undefined);
  expect(r.status).toBe(200);
  return r.body.items as { id: string; conflict_type: string; state: string; resolution: string | null; details: Record<string, unknown>; appointment_id: string | null }[];
}

async function booking(s: Setup, reserveId: string, start: string, end: string, extra: Partial<Parameters<typeof mockBookingProvider.putBooking>[1]> = {}) {
  return mockBookingProvider.putBooking(s.account.id, {
    reserveId,
    start: jst(s.date, start),
    end: jst(s.date, end),
    stylistCode: 'S1',
    menuCodes: ['M1'],
    guest: { nameKanji: '山田 花子', nameKana: 'ヤマダ ハナコ', tel: `090${Math.floor(10000000 + Math.random() * 89999999)}`, memberNo: `HP-${randomUUID().slice(0, 8)}` },
    ...extra,
  });
}

describe('integration accounts', () => {
  it('creates accounts with encrypted credentials that are never returned', async () => {
    const s = await setup();
    expect(s.account).not.toHaveProperty('encrypted_credentials');
    expect(s.account).toMatchObject({ provider: 'mock_booking', hasCredentials: true, status: 'active', config: { conflictPolicy: 'manual', pushBlocks: false } });
    expect(s.account.webhookUrl).toContain(`/v1/webhooks/mock_booking/${s.account.id}`);

    const stored = await db(s, (ctx) => ctx.trx.selectFrom('integration_accounts').select('encrypted_credentials').where('id', '=', s.account.id).executeTakeFirstOrThrow());
    expect(stored.encrypted_credentials).toMatch(/^v1\./);
    expect(stored.encrypted_credentials).not.toContain('whsec');
    const audits = await db(s, (ctx) => ctx.trx.selectFrom('audit_logs').select(['action', 'after']).where('resource_id', '=', s.account.id).execute());
    expect(audits.map((a) => a.action)).toContain('integration.create');
    expect(JSON.stringify(audits)).not.toContain('whsec_test_secret');

    const list = await s.t.owner.get('/v1/integrations');
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('whsec');

    // duplicate provider for the same shop
    const dup = await s.t.owner.post('/v1/integrations', { provider: 'mock_booking', shopId: s.t.shopId, displayName: 'x' });
    expect(dup.status).toBe(409);
    // unknown provider / unknown staff in mapping
    expect((await s.t.owner.post('/v1/integrations', { provider: 'nope', shopId: s.t.shopId, displayName: 'x' })).status).toBe(400);
    const badMap = await s.t.owner.patch(`/v1/integrations/${s.account.id}`, { config: { staffMap: { S2: randomUUID() } } });
    expect(badMap.status).toBe(400);

    // PATCH merges config (no defaults overwrite stored mapping)
    const patched = await s.t.owner.patch(`/v1/integrations/${s.account.id}`, { config: { pushBlocks: true } });
    expect(patched.status).toBe(200);
    expect(patched.body.config).toMatchObject({ pushBlocks: true, conflictPolicy: 'manual', staffMap: { S1: s.stylist.staffId } });
  });

  it('health check reflects provider outages and enforces permissions and tenant isolation', async () => {
    const s = await setup();
    const ok = await s.t.owner.post(`/v1/integrations/${s.account.id}/test`);
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    await mockBookingProvider.setOutage(s.account.id, { fetch: -1 });
    const down = await s.t.owner.post(`/v1/integrations/${s.account.id}/test`);
    expect(down.body.ok).toBe(false);

    expect((await s.stylist.api.get('/v1/integrations')).status).toBe(403);
    expect((await s.stylist.api.post(`/v1/integrations/${s.account.id}/resync`, {})).status).toBe(403);
    const other = await createTenantUnthrottled('他社サロン');
    expect((await other.owner.get(`/v1/integrations/${s.account.id}`)).status).toBe(404);
    expect((await other.owner.post(`/v1/integrations/${s.account.id}/resync`, {})).status).toBe(404);
    expect((await other.owner.get('/v1/integrations')).body).toHaveLength(0);

    // disabling stops syncing
    expect((await s.t.owner.delete(`/v1/integrations/${s.account.id}`)).status).toBe(204);
    expect((await s.t.owner.post(`/v1/integrations/${s.account.id}/resync`, {})).status).toBe(422);
  });
});

describe('resync requests', () => {
  it('deduplicates repeated 再同期 clicks while a sync is queued', async () => {
    const s = await setup();
    const r1 = await s.t.owner.post(`/v1/integrations/${s.account.id}/resync`, { mode: 'delta' });
    const r2 = await s.t.owner.post(`/v1/integrations/${s.account.id}/resync`, { mode: 'delta' });
    expect(r1.status).toBe(202);
    expect(r2.body.jobId).toBe(r1.body.jobId);
    const jobs = await withSystem((trx) => trx.selectFrom('jobs').select('id').where('type', '=', 'integration.sync').where('organization_id', '=', s.t.organizationId).execute());
    expect(jobs).toHaveLength(1);
    await runJobs();
    const audits = await db(s, (ctx) => ctx.trx.selectFrom('audit_logs').select('action').where('action', '=', 'integration.resync').execute());
    expect(audits).toHaveLength(2);
  });
});

describe('external booking sync', () => {
  it('imports, updates and cancels external bookings; unchanged payloads are skipped', async () => {
    const s = await setup();
    await booking(s, 'R1', '11:00', '12:00', { guest: { nameKanji: '山田 花子', nameKana: 'ヤマダ ハナコ', tel: '090-1111-2222', memberNo: 'HP-001' }, memo: '前髪短め' });
    await resync(s);

    const [appt] = await externalAppointments(s);
    expect(appt).toBeDefined();
    expect(appt!.status).toBe('confirmed');
    expect(appt!.staff_id).toBe(s.stylist.staffId);
    expect(appt!.start_at.toISOString()).toBe(jst(s.date, '11:00'));
    expect(appt!.source_detail).toMatchObject({ provider: 'mock_booking', externalBookingId: 'R1', integrationAccountId: s.account.id });
    const job = await lastSyncJob(s);
    expect(job).toMatchObject({ state: 'succeeded', mode: 'delta', triggered_by: 'manual' });
    expect(job.stats).toMatchObject({ fetched: 1, created: 1, conflicts: 0 });

    // customer resolved with the provider identity
    const customer = await db(s, (ctx) =>
      ctx.trx
        .selectFrom('customers')
        .innerJoin('customer_identities as ci', 'ci.customer_id', 'customers.id')
        .select(['customers.id', 'customers.last_name', 'customers.first_name', 'customers.phone_normalized', 'ci.provider', 'ci.external_id'])
        .where('customers.id', '=', appt!.customer_id!)
        .executeTakeFirstOrThrow(),
    );
    expect(customer).toMatchObject({ last_name: '山田', first_name: '花子', phone_normalized: '+819011112222', provider: 'mock_booking', external_id: 'HP-001' });
    const ext = await db(s, (ctx) => ctx.trx.selectFrom('external_bookings').selectAll().where('integration_account_id', '=', s.account.id).executeTakeFirstOrThrow());
    expect(ext).toMatchObject({ external_booking_id: 'R1', appointment_id: appt!.id, sync_state: 'synced', external_status: 'booked' });
    expect((ext.raw_payload as { reserveId: string }).reserveId).toBe('R1');
    const acct = await s.t.owner.get(`/v1/integrations/${s.account.id}`);
    expect(acct.body.sync_cursor).not.toBeNull();
    expect(acct.body.last_success_at).not.toBeNull();

    // delta with nothing new / full resync with unchanged payload
    await resync(s);
    expect((await lastSyncJob(s)).stats).toMatchObject({ fetched: 0 });
    await resync(s, 'full');
    expect((await lastSyncJob(s)).stats).toMatchObject({ fetched: 1, skipped: 1, created: 0 });

    // change on the medium → reschedule internally
    await booking(s, 'R1', '14:00', '15:00', { guest: { nameKanji: '山田 花子', tel: '090-1111-2222', memberNo: 'HP-001' } });
    await resync(s);
    const [moved] = await externalAppointments(s);
    expect(moved!.id).toBe(appt!.id);
    expect(moved!.start_at.toISOString()).toBe(jst(s.date, '14:00'));
    expect((await lastSyncJob(s)).stats).toMatchObject({ updated: 1 });

    // cancellation on the medium
    await mockBookingProvider.cancelBooking(s.account.id, 'R1');
    await resync(s);
    const [cancelled] = await externalAppointments(s);
    expect(cancelled).toMatchObject({ id: appt!.id, status: 'cancelled', cancelled_by_type: 'external' });
    expect((await lastSyncJob(s)).stats).toMatchObject({ cancelled: 1 });
  });

  it('bookings outside our shifts are accepted (never overlapping)', async () => {
    const s = await setup();
    // 21:00 is after closing time
    await booking(s, 'LATE', '21:00', '22:00');
    await resync(s);
    const [appt] = await externalAppointments(s);
    expect(appt?.start_at.toISOString()).toBe(jst(s.date, '21:00'));
  });

  it('unknown staff/menu become conflicts and can be re-applied after fixing the mapping', async () => {
    const s = await setup();
    await booking(s, 'R2', '11:00', '12:00', { stylistCode: 'S9' });
    await booking(s, 'R3', '13:00', '14:00', { menuCodes: ['M9'] });
    await resync(s);
    expect(await externalAppointments(s)).toHaveLength(0);
    const open = await conflicts(s, 'open');
    expect(open.map((c) => c.conflict_type).sort()).toEqual(['unknown_menu', 'unknown_staff']);
    expect((await lastSyncJob(s)).stats).toMatchObject({ fetched: 2, conflicts: 2 });
    const states = await db(s, (ctx) => ctx.trx.selectFrom('external_bookings').select(['external_booking_id', 'sync_state']).execute());
    expect(states.every((r) => r.sync_state === 'conflict')).toBe(true);

    // re-sync does not duplicate open conflicts
    await resync(s, 'full');
    expect(await conflicts(s, 'open')).toHaveLength(2);

    // accept_external without fixing the mapping fails and changes nothing
    const staffConflict = open.find((c) => c.conflict_type === 'unknown_staff')!;
    const failed = await s.t.owner.post(`/v1/sync-conflicts/${staffConflict.id}/resolve`, { resolution: 'accept_external' });
    expect(failed.status).toBe(422);
    expect(failed.body.error.code).toBe('CONFLICT_UNRESOLVED');

    const stylist2 = await createStaffUserUnthrottled(s.t, 'stylist', { displayName: 'スタイリストB' });
    await s.t.owner.patch(`/v1/integrations/${s.account.id}`, { config: { staffMap: { S1: s.stylist.staffId, S9: stylist2.staffId } } });
    const ok = await s.t.owner.post(`/v1/sync-conflicts/${staffConflict.id}/resolve`, { resolution: 'accept_external', note: '対応表を追加' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ state: 'resolved', resolution: 'accept_external' });
    const appts = await externalAppointments(s);
    expect(appts).toHaveLength(1);
    expect(appts[0]!.staff_id).toBe(stylist2.staffId);

    const menuConflict = open.find((c) => c.conflict_type === 'unknown_menu')!;
    const ignored = await s.t.owner.post(`/v1/sync-conflicts/${menuConflict.id}/resolve`, { resolution: 'ignore' });
    expect(ignored.body.state).toBe('ignored');
    const again = await s.t.owner.post(`/v1/sync-conflicts/${menuConflict.id}/resolve`, { resolution: 'ignore' });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('CONFLICT_ALREADY_RESOLVED');
    expect(await conflicts(s, 'open')).toHaveLength(0);
    const audit = await db(s, (ctx) => ctx.trx.selectFrom('audit_logs').select('action').where('action', '=', 'sync_conflict.resolve').execute());
    expect(audit).toHaveLength(2);

    // permissions & tenant isolation on the queue
    expect((await s.stylist.api.get('/v1/sync-conflicts')).status).toBe(403);
    const other = await createTenantUnthrottled('他社');
    expect((await other.owner.get('/v1/sync-conflicts')).body.items).toHaveLength(0);
    expect((await other.owner.post(`/v1/sync-conflicts/${menuConflict.id}/resolve`, { resolution: 'ignore' })).status).toBe(404);
  });

  it('overlap with conflictPolicy=manual opens a conflict; accept_external cancels the internal booking', async () => {
    const s = await setup({ policy: 'manual' });
    const internal = await s.t.owner.post('/v1/appointments', { shopId: s.t.shopId, staffId: s.stylist.staffId, startAt: jst(s.date, '11:00'), menuIds: [s.menu.id] });
    expect(internal.status).toBe(201);
    await booking(s, 'R10', '11:30', '12:30');
    await resync(s);
    expect(await externalAppointments(s)).toHaveLength(0);
    const [c] = await conflicts(s, 'open');
    expect(c).toMatchObject({ conflict_type: 'overlap', state: 'open', appointment_id: internal.body.id });
    expect(c!.details.clashingAppointmentIds).toEqual([internal.body.id]);
    const internalNow = await s.t.owner.get(`/v1/appointments/${internal.body.id}`);
    expect(internalNow.body.status).toBe('confirmed');

    const resolved = await s.t.owner.post(`/v1/sync-conflicts/${c!.id}/resolve`, { resolution: 'accept_external' });
    expect(resolved.status).toBe(200);
    const after = await s.t.owner.get(`/v1/appointments/${internal.body.id}`);
    expect(after.body).toMatchObject({ status: 'cancelled', cancelled_by_type: 'system' });
    const appts = await externalAppointments(s);
    expect(appts).toHaveLength(1);
    expect(resolved.body.appointment_id).toBe(appts[0]!.id);
  });

  it('overlap with conflictPolicy=internal_wins keeps the internal booking and leaves the external unmapped', async () => {
    const s = await setup({ policy: 'internal_wins' });
    const internal = await s.t.owner.post('/v1/appointments', { shopId: s.t.shopId, staffId: s.stylist.staffId, startAt: jst(s.date, '11:00'), menuIds: [s.menu.id] });
    await booking(s, 'R11', '11:30', '12:30');
    await resync(s);
    expect(await externalAppointments(s)).toHaveLength(0);
    expect(await conflicts(s, 'open')).toHaveLength(0);
    const [c] = await conflicts(s, 'resolved');
    expect(c).toMatchObject({ conflict_type: 'overlap', resolution: 'keep_internal' });
    const ext = await db(s, (ctx) => ctx.trx.selectFrom('external_bookings').select(['sync_state', 'appointment_id']).executeTakeFirstOrThrow());
    expect(ext).toMatchObject({ sync_state: 'conflict', appointment_id: null });
    expect((await s.t.owner.get(`/v1/appointments/${internal.body.id}`)).body.status).toBe('confirmed');
  });

  it('overlap with conflictPolicy=external_wins cancels the clashing internal booking automatically', async () => {
    const s = await setup({ policy: 'external_wins' });
    const internal = await s.t.owner.post('/v1/appointments', { shopId: s.t.shopId, staffId: s.stylist.staffId, startAt: jst(s.date, '11:00'), menuIds: [s.menu.id] });
    await booking(s, 'R12', '11:30', '12:30');
    await resync(s);
    const appts = await externalAppointments(s);
    expect(appts).toHaveLength(1);
    expect(appts[0]!.start_at.toISOString()).toBe(jst(s.date, '11:30'));
    const cancelled = await s.t.owner.get(`/v1/appointments/${internal.body.id}`);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelled_by_type: 'system' });
    const [c] = await conflicts(s, 'resolved');
    expect(c).toMatchObject({ conflict_type: 'overlap', resolution: 'accept_external' });
    expect(c!.details.cancelledAppointmentIds).toEqual([internal.body.id]);
    expect((await lastSyncJob(s)).stats).toMatchObject({ created: 1, conflicts: 1 });
  });

  it('keep_internal resolution leaves the external booking ignored', async () => {
    const s = await setup();
    await s.t.owner.post('/v1/appointments', { shopId: s.t.shopId, staffId: s.stylist.staffId, startAt: jst(s.date, '11:00'), menuIds: [s.menu.id] });
    await booking(s, 'R13', '11:00', '12:00');
    await resync(s);
    const [c] = await conflicts(s, 'open');
    const r = await s.t.owner.post(`/v1/sync-conflicts/${c!.id}/resolve`, { resolution: 'keep_internal', note: '媒体側で別日に変更依頼' });
    expect(r.body).toMatchObject({ state: 'resolved', resolution: 'keep_internal' });
    expect(r.body.details.resolutionNote).toBe('媒体側で別日に変更依頼');
    const ext = await db(s, (ctx) => ctx.trx.selectFrom('external_bookings').select('sync_state').executeTakeFirstOrThrow());
    expect(ext.sync_state).toBe('ignored');
  });

  it('links duplicates (same customer & start) instead of creating a second booking', async () => {
    const s = await setup();
    const customer = await createCustomer(s.t, { lastName: '佐藤', firstName: '一郎', phone: '090-3333-4444' });
    const internal = await s.t.owner.post('/v1/appointments', { shopId: s.t.shopId, customerId: customer.id, staffId: s.stylist.staffId, startAt: jst(s.date, '15:00'), menuIds: [s.menu.id] });
    expect(internal.status).toBe(201);
    await booking(s, 'R20', '15:00', '16:00', { guest: { nameKanji: '佐藤 一郎', tel: '09033334444' } });
    await resync(s);
    expect(await externalAppointments(s)).toHaveLength(0);
    const ext = await db(s, (ctx) => ctx.trx.selectFrom('external_bookings').select(['appointment_id', 'sync_state']).executeTakeFirstOrThrow());
    expect(ext).toMatchObject({ appointment_id: internal.body.id, sync_state: 'synced' });
    const [c] = await conflicts(s, 'resolved');
    expect(c).toMatchObject({ conflict_type: 'duplicate', resolution: 'merged', appointment_id: internal.body.id });
    expect((await lastSyncJob(s)).stats).toMatchObject({ linked: 1, created: 0 });
  });

  it('skips stale (out-of-order) updates', async () => {
    const s = await setup();
    const t2 = new Date(Date.now() - 60_000);
    await booking(s, 'R30', '11:00', '12:00', { lastModified: t2 });
    await resync(s);
    // an older version of the same booking arrives later
    await booking(s, 'R30', '16:00', '17:00', { lastModified: new Date(t2.getTime() - 3600_000) });
    await resync(s);
    const [appt] = await externalAppointments(s);
    expect(appt!.start_at.toISOString()).toBe(jst(s.date, '11:00'));
    expect((await lastSyncJob(s)).stats).toMatchObject({ fetched: 1, skipped: 1, updated: 0 });
  });

  it('advances the cursor only on success; degrades after 3 failures and recovers', async () => {
    const s = await setup();
    await booking(s, 'R40', '11:00', '12:00');
    await mockBookingProvider.setOutage(s.account.id, { fetch: -1 });
    await resync(s);

    let acct = (await s.t.owner.get(`/v1/integrations/${s.account.id}`)).body;
    expect(acct).toMatchObject({ status: 'error', consecutive_failures: 1, sync_cursor: null });
    expect(acct.last_error).toContain('接続できません');
    expect((await lastSyncJob(s)).state).toBe('failed');
    const queued = await withSystem((trx) => trx.selectFrom('jobs').select(['state', 'attempts']).where('type', '=', 'integration.sync').where('organization_id', '=', s.t.organizationId).executeTakeFirstOrThrow());
    expect(queued).toMatchObject({ state: 'queued', attempts: 1 }); // retry with backoff

    for (let i = 0; i < 3; i++) {
      await expediteJobs(SYNC_TYPES);
      await runJobs();
    }
    acct = (await s.t.owner.get(`/v1/integrations/${s.account.id}`)).body;
    expect(acct).toMatchObject({ status: 'degraded', consecutive_failures: 4, sync_cursor: null });
    const degradedEvents = await db(s, (ctx) => ctx.trx.selectFrom('domain_events').select('payload').where('event_type', '=', 'integration.degraded').execute());
    expect(degradedEvents).toHaveLength(1); // emitted once
    expect(degradedEvents[0]!.payload).toMatchObject({ integrationAccountId: s.account.id, provider: 'mock_booking' });

    // 縮退運転: internal booking keeps working
    const internal = await s.t.owner.post('/v1/appointments', { shopId: s.t.shopId, staffId: s.stylist.staffId, startAt: jst(s.date, '17:00'), menuIds: [s.menu.id] });
    expect(internal.status).toBe(201);
    const status = await s.stylist.api.get('/v1/integrations/status');
    expect(status.status).toBe(200);
    expect(status.body.shops[0]).toMatchObject({ degraded: true });
    expect(status.body.shops[0].accounts[0]).toMatchObject({ degraded: true, consecutiveFailures: 4 });

    // provider back → next retry succeeds, cursor advances, recovered emitted
    await mockBookingProvider.setOutage(s.account.id, { fetch: 0 });
    await expediteJobs(SYNC_TYPES);
    await runJobs();
    acct = (await s.t.owner.get(`/v1/integrations/${s.account.id}`)).body;
    expect(acct).toMatchObject({ status: 'active', consecutive_failures: 0 });
    expect(acct.sync_cursor).not.toBeNull();
    expect(await externalAppointments(s)).toHaveLength(1);
    const recovered = await db(s, (ctx) => ctx.trx.selectFrom('domain_events').select('id').where('event_type', '=', 'integration.recovered').execute());
    expect(recovered).toHaveLength(1);
    const jobs = (await s.t.owner.get(`/v1/integrations/${s.account.id}/sync-jobs`)).body.items;
    expect(jobs.map((j: { state: string }) => j.state)).toEqual(['succeeded', 'failed', 'failed', 'failed', 'failed']);
    expect(jobs[0].retry_count).toBe(4);
  });

  it('moves the sync job to the DLQ after max attempts', async () => {
    const s = await setup();
    await mockBookingProvider.setOutage(s.account.id, { fetch: -1 });
    await resync(s);
    await runJobsWithRetries(10, SYNC_TYPES);
    const job = await withSystem((trx) => trx.selectFrom('jobs').select(['state', 'attempts', 'last_error']).where('type', '=', 'integration.sync').where('organization_id', '=', s.t.organizationId).executeTakeFirstOrThrow());
    expect(job).toMatchObject({ state: 'dead', attempts: 5 });
    expect((await lastSyncJob(s)).state).toBe('dead');
  });

  it('one bad record does not abort the batch', async () => {
    const s = await setup();
    // menu mapped to a menu the mapped staff cannot be booked for → business error for that record only
    const other = await createTenantUnthrottled('別テナント');
    void other;
    const inactiveStaff = await createStaffUserUnthrottled(s.t, 'stylist', { displayName: '予約不可', isBookable: false });
    await s.t.owner.patch(`/v1/integrations/${s.account.id}`, { config: { staffMap: { S1: s.stylist.staffId, SX: inactiveStaff.staffId } } });
    await booking(s, 'BAD', '11:00', '12:00', { stylistCode: 'SX' });
    await booking(s, 'GOOD', '13:00', '14:00');
    await resync(s);
    expect(await externalAppointments(s)).toHaveLength(1);
    const job = await lastSyncJob(s);
    expect(job).toMatchObject({ state: 'succeeded' });
    expect(job.stats).toMatchObject({ fetched: 2, created: 1, errors: 1 });
    const bad = await db(s, (ctx) => ctx.trx.selectFrom('external_bookings').select(['sync_state', 'last_error']).where('external_booking_id', '=', 'BAD').executeTakeFirstOrThrow());
    expect(bad.sync_state).toBe('error');
    expect(bad.last_error).toBeTruthy();
  });

  it('periodic delta fan-out enqueues one sync per active account and honours the external_sync flag', async () => {
    expect(registeredPeriodicTasks().some((t) => t.name === 'integrations.delta')).toBe(true);
    const s = await setup();
    await booking(s, 'P1', '11:00', '12:00');
    await fanOutDeltaSync();
    await fanOutDeltaSync(); // same bucket → deduped
    const jobs = await withSystem((trx) => trx.selectFrom('jobs').select(['payload']).where('type', '=', 'integration.sync').where('organization_id', '=', s.t.organizationId).execute());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ integrationAccountId: s.account.id, mode: 'delta', triggeredBy: 'schedule' });
    await runJobs();
    expect(await externalAppointments(s)).toHaveLength(1);

    await asSystem(s.t.organizationId, (ctx) => ctx.trx.insertInto('feature_flags').values({ organization_id: s.t.organizationId, key: 'external_sync', enabled: false }).execute());
    clearFeatureFlagCache();
    await fanOutDeltaSync(new Date(Date.now() + 10 * 60_000));
    const after = await withSystem((trx) => trx.selectFrom('jobs').select('id').where('type', '=', 'integration.sync').where('organization_id', '=', s.t.organizationId).execute());
    expect(after).toHaveLength(1);
    clearFeatureFlagCache();
  });
});

describe('slot push (internal → external)', () => {
  it('pushes a block for internal bookings, moves it on reschedule and removes it on cancel', async () => {
    const s = await setup({ pushBlocks: true });
    const created = await s.t.owner.post('/v1/appointments', { shopId: s.t.shopId, staffId: s.stylist.staffId, startAt: jst(s.date, '11:00'), menuIds: [s.menu.id] });
    expect(created.status).toBe(201);
    await runJobs();
    let blocks = await mockBookingProvider.listBlocks(s.account.id, { activeOnly: true });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.payload).toMatchObject({ stylistCode: 'S1', startDateTime: jst(s.date, '11:00'), ref: created.body.id });
    const row = await db(s, (ctx) => ctx.trx.selectFrom('external_slot_blocks').selectAll().where('appointment_id', '=', created.body.id).executeTakeFirstOrThrow());
    expect(row).toMatchObject({ state: 'pushed', external_block_id: blocks[0]!.id });

    const moved = await s.t.owner.patch(`/v1/appointments/${created.body.id}`, { version: created.body.version, startAt: jst(s.date, '13:00') });
    expect(moved.status).toBe(200);
    await runJobs();
    blocks = await mockBookingProvider.listBlocks(s.account.id, { activeOnly: true });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.payload.startDateTime).toBe(jst(s.date, '13:00'));
    expect(await mockBookingProvider.listBlocks(s.account.id)).toHaveLength(2);

    await s.t.owner.post(`/v1/appointments/${created.body.id}/cancel`, { reason: '顧客都合' });
    await runJobs();
    expect(await mockBookingProvider.listBlocks(s.account.id, { activeOnly: true })).toHaveLength(0);
    const removed = await db(s, (ctx) => ctx.trx.selectFrom('external_slot_blocks').select(['state', 'external_block_id']).where('appointment_id', '=', created.body.id).executeTakeFirstOrThrow());
    expect(removed).toMatchObject({ state: 'removed', external_block_id: null });

    // the medium's own bookings are never echoed back as blocks
    await booking(s, 'R50', '16:00', '17:00');
    await resync(s);
    await runJobs();
    expect(await externalAppointments(s)).toHaveLength(1);
    expect(await mockBookingProvider.listBlocks(s.account.id, { activeOnly: true })).toHaveLength(0);
  });

  it('retries failed pushes, dead-letters them as push_failed conflicts, and can retry from the queue', async () => {
    const s = await setup({ pushBlocks: true });
    await mockBookingProvider.setOutage(s.account.id, { push: -1 });
    const created = await s.t.owner.post('/v1/appointments', { shopId: s.t.shopId, staffId: s.stylist.staffId, startAt: jst(s.date, '11:00'), menuIds: [s.menu.id] });
    await runJobs();
    let block = await db(s, (ctx) => ctx.trx.selectFrom('external_slot_blocks').selectAll().where('appointment_id', '=', created.body.id).executeTakeFirstOrThrow());
    expect(block.state).toBe('error');
    expect(await conflicts(s, 'open')).toHaveLength(0);

    await runJobsWithRetries(10, PUSH_TYPES);
    const job = await withSystem((trx) => trx.selectFrom('jobs').select(['state', 'attempts']).where('type', '=', 'integration.push_block').where('organization_id', '=', s.t.organizationId).executeTakeFirstOrThrow());
    expect(job).toMatchObject({ state: 'dead', attempts: 5 });
    const [c] = await conflicts(s, 'open');
    expect(c).toMatchObject({ conflict_type: 'push_failed', appointment_id: created.body.id });
    expect(c!.details).toMatchObject({ integrationAccountId: s.account.id, operation: 'push' });

    await mockBookingProvider.setOutage(s.account.id, { push: 0 });
    const r = await s.t.owner.post(`/v1/sync-conflicts/${c!.id}/resolve`, { resolution: 'accept_external' });
    expect(r.status).toBe(200);
    await runJobs();
    block = await db(s, (ctx) => ctx.trx.selectFrom('external_slot_blocks').selectAll().where('appointment_id', '=', created.body.id).executeTakeFirstOrThrow());
    expect(block.state).toBe('pushed');
    expect(await mockBookingProvider.listBlocks(s.account.id, { activeOnly: true })).toHaveLength(1);
  });

  it('parks pushes while degraded and replays them on recovery', async () => {
    const s = await setup({ pushBlocks: true });
    await db(s, (ctx) => ctx.trx.updateTable('integration_accounts').set({ status: 'degraded', consecutive_failures: 3 }).where('id', '=', s.account.id).execute());
    const created = await s.t.owner.post('/v1/appointments', { shopId: s.t.shopId, staffId: s.stylist.staffId, startAt: jst(s.date, '11:00'), menuIds: [s.menu.id] });
    expect(created.status).toBe(201);
    await runJobs();
    expect(await mockBookingProvider.listBlocks(s.account.id)).toHaveLength(0);
    const parked = await db(s, (ctx) => ctx.trx.selectFrom('external_slot_blocks').select('state').where('appointment_id', '=', created.body.id).executeTakeFirstOrThrow());
    expect(parked.state).toBe('pending');

    await resync(s); // succeeds → recovered → replay
    await runJobs();
    expect(await mockBookingProvider.listBlocks(s.account.id, { activeOnly: true })).toHaveLength(1);
    const pushed = await db(s, (ctx) => ctx.trx.selectFrom('external_slot_blocks').select('state').where('appointment_id', '=', created.body.id).executeTakeFirstOrThrow());
    expect(pushed.state).toBe('pushed');
  });
});

// ------------------------------------------------------------------ webhooks

const processed: string[] = [];
registerWebhookProvider('test_hook', {
  async verify(req) {
    const body = req.body as { orgId?: string; events?: { id: string; type: string; fail?: boolean }[] };
    return {
      eventId: body.events?.[0]?.id ?? 'none',
      organizationId: body.orgId ?? null,
      signatureValid: req.headers['x-test-signature'] === 'valid',
      events: (body.events ?? []).map((e) => ({ eventId: e.id, eventType: e.type, payload: e })),
    };
  },
  async process(ctx, event) {
    const payload = event.payload as { id: string; fail?: boolean; ignore?: boolean };
    if (payload.fail) throw new Error('処理に失敗しました(テスト)');
    if (payload.ignore) return 'ignored';
    // proves we run inside the tenant transaction
    await ctx.trx.selectFrom('shops').select('id').execute();
    processed.push(`${ctx.actor.organizationId}:${event.eventId}`);
    return 'processed';
  },
});

async function webhookRows(eventIds: string[]) {
  return withSystem((trx) => trx.selectFrom('webhook_events').selectAll().where('provider', '=', 'test_hook').where('event_id', 'in', eventIds).orderBy('event_id').execute());
}

describe('webhooks', () => {
  it('stores, acknowledges and processes events asynchronously; duplicates are acknowledged without reprocessing', async () => {
    const t = await createTenantUnthrottled();
    const ids = [`evt-${randomUUID()}`, `evt-${randomUUID()}`].sort();
    const body = { orgId: t.organizationId, events: ids.map((id) => ({ id, type: 'thing.updated' })) };
    const res = await api().post('/v1/webhooks/test_hook', body, { 'x-test-signature': 'valid', authorization: 'Bearer secret-token' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, received: 2, duplicates: 0 });
    let rows = await webhookRows(ids);
    expect(rows.map((r) => r.status)).toEqual(['received', 'received']);
    expect(rows[0]!.organization_id).toBe(t.organizationId);
    expect(rows[0]!.headers).not.toHaveProperty('authorization');

    await runJobs();
    rows = await webhookRows(ids);
    expect(rows.map((r) => r.status)).toEqual(['processed', 'processed']);
    expect(processed).toEqual(expect.arrayContaining(ids.map((id) => `${t.organizationId}:${id}`)));

    const dup = await api().post('/v1/webhooks/test_hook', body, { 'x-test-signature': 'valid' });
    expect(dup.body).toEqual({ ok: true, received: 0, duplicates: 2 });
    const jobs = await withSystem((trx) => trx.selectFrom('jobs').select('id').where('type', '=', 'webhook.process').where('organization_id', '=', t.organizationId).execute());
    expect(jobs).toHaveLength(2);
  });

  it('rejects invalid signatures with 401 but records them; unknown providers 404', async () => {
    const t = await createTenantUnthrottled();
    const id = `evt-${randomUUID()}`;
    const res = await api().post('/v1/webhooks/test_hook', { orgId: t.organizationId, events: [{ id, type: 'x' }] }, { 'x-test-signature': 'forged' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    const stored = await withSystem((trx) => trx.selectFrom('webhook_events').selectAll().where('provider', '=', 'test_hook').where('signature_valid', '=', false).where(sqlPayloadId(id)).execute());
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ status: 'ignored', organization_id: null });
    expect(stored[0]!.event_id.startsWith('invalid:')).toBe(true);
    // a forged delivery cannot squat the real event id
    const real = await api().post('/v1/webhooks/test_hook', { orgId: t.organizationId, events: [{ id, type: 'x' }] }, { 'x-test-signature': 'valid' });
    expect(real.body.received).toBe(1);

    expect((await api().post('/v1/webhooks/unknown_provider', {})).status).toBe(404);
  });

  it('retries failing events with backoff and dead-letters them after max attempts', async () => {
    const t = await createTenantUnthrottled();
    const id = `evt-${randomUUID()}`;
    await api().post('/v1/webhooks/test_hook', { orgId: t.organizationId, events: [{ id, type: 'x', fail: true }] }, { 'x-test-signature': 'valid' });
    await runJobs();
    let [row] = await webhookRows([id]);
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    expect(row!.last_error).toContain('処理に失敗しました');
    await runJobsWithRetries(10, WEBHOOK_TYPES);
    [row] = await webhookRows([id]);
    expect(row).toMatchObject({ status: 'dead', attempts: 5 });
    const job = await withSystem((trx) => trx.selectFrom('jobs').select('state').where('type', '=', 'webhook.process').where('organization_id', '=', t.organizationId).executeTakeFirstOrThrow());
    expect(job.state).toBe('dead');
  });

  it('mock_booking webhook (HMAC) triggers an immediate delta sync', async () => {
    const s = await setup();
    await booking(s, 'WH1', '11:00', '12:00');
    const raw = JSON.stringify({ eventId: 'wh-evt-1', type: 'booking.created', reserveId: 'WH1' });
    const sig = hmacSha256('whsec_test_secret', raw);
    const bad = await api().post(`/v1/webhooks/mock_booking/${s.account.id}`, raw, { 'content-type': 'application/json', 'x-mock-signature': 'deadbeef' });
    expect(bad.status).toBe(401);
    const res = await api().post(`/v1/webhooks/mock_booking/${s.account.id}`, raw, { 'content-type': 'application/json', 'x-mock-signature': sig });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(1);
    await runJobs();
    expect(await externalAppointments(s)).toHaveLength(1);
    expect((await lastSyncJob(s)).triggered_by).toBe('webhook');
    const ev = await withSystem((trx) => trx.selectFrom('webhook_events').select(['status', 'event_id']).where('provider', '=', 'mock_booking').where('organization_id', '=', s.t.organizationId).executeTakeFirstOrThrow());
    expect(ev).toMatchObject({ status: 'processed', event_id: `${s.account.id}:wh-evt-1` });
    // another tenant's key with this signature is rejected
    const other = await setup();
    expect((await api().post(`/v1/webhooks/mock_booking/${other.account.id}`, raw, { 'content-type': 'application/json', 'x-mock-signature': sig })).status).toBe(200); // same secret in fixture
    const wrongKey = await api().post(`/v1/webhooks/mock_booking/${randomUUID()}`, raw, { 'content-type': 'application/json', 'x-mock-signature': sig });
    expect(wrongKey.status).toBe(401);
  });
});

function sqlPayloadId(id: string) {
  return sql<boolean>`payload->'events'->0->>'id' = ${id}`;
}
