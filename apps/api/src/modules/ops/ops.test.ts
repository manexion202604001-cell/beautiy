import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withSystem } from '../../db/tenant.js';
import { registerJob } from '../../jobs/queue.js';
import { registeredPeriodicTasks } from '../../jobs/scheduler.js';
import { clearFeatureFlagCache, evaluateFlag, isFeatureEnabled } from '../../lib/feature-flags.js';
import { storage, verifyLocalBlobToken } from '../../lib/storage.js';
import { registerWebhookProvider } from '../../lib/webhooks.js';
import {
  asSystem,
  createCustomer,
  createMenu,
  createStaffUserUnthrottled,
  createTenantUnthrottled,
  jst,
  nextWeekday,
  runJobs,
  runJobsWithRetries,
  type Tenant,
} from '../../test/helpers.js';
import { runRetention } from './retention.js';

const DAY = 86_400_000;

async function insertJob(orgId: string | null, values: Record<string, unknown> = {}) {
  return withSystem((trx) =>
    trx
      .insertInto('jobs')
      .values({ organization_id: orgId, type: 'test.noop', payload: JSON.stringify({}), state: 'dead', attempts: 8, last_error: 'Error: boom', finished_at: new Date(), ...values })
      .returning('id')
      .executeTakeFirstOrThrow(),
  ).then((r) => r.id);
}

async function insertWebhookEvent(orgId: string | null, values: Record<string, unknown> = {}) {
  return withSystem((trx) =>
    trx
      .insertInto('webhook_events')
      .values({ organization_id: orgId, provider: 'ops_test_hook', event_id: `e-${randomUUID()}`, signature_valid: true, payload: JSON.stringify({ hello: 'world' }), status: 'dead', attempts: 5, last_error: 'boom', ...values })
      .returning('id')
      .executeTakeFirstOrThrow(),
  ).then((r) => r.id);
}

const reprocessed: string[] = [];
registerWebhookProvider('ops_test_hook', {
  async verify() {
    return { eventId: 'x', signatureValid: false };
  },
  async process(ctx, event) {
    reprocessed.push(`${ctx.actor.organizationId}:${event.eventId}`);
    return 'processed';
  },
});

let flakyShouldFail = true;
registerJob('test.flaky', async () => {
  if (flakyShouldFail) throw new Error('一時的な障害(テスト)');
});

describe('ops dashboard & DLQ', () => {
  it('shows org-scoped failures and hides other tenants and global jobs', async () => {
    const a = await createTenantUnthrottled('A');
    const b = await createTenantUnthrottled('B');
    const deadJob = await insertJob(a.organizationId);
    const globalJob = await insertJob(null);
    await insertWebhookEvent(a.organizationId);
    await insertWebhookEvent(a.organizationId, { status: 'failed' });
    await asSystem(a.organizationId, async (ctx) => {
      await ctx.trx.insertInto('messages').values({ organization_id: a.organizationId, channel: 'email', direction: 'outbound', status: 'failed', error: 'SMTP 550', body: 'x' }).execute();
      await ctx.trx
        .insertInto('integration_accounts')
        .values({ organization_id: a.organizationId, shop_id: a.shopId, provider: 'mock_booking', display_name: '媒体', status: 'degraded', last_error: '503', last_error_at: new Date(), consecutive_failures: 3 })
        .execute();
      await ctx.trx.insertInto('sync_conflicts').values({ organization_id: a.organizationId, conflict_type: 'overlap', details: JSON.stringify({}) }).execute();
    });

    const res = await a.owner.get('/v1/ops/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.webhookEvents).toMatchObject({ failed: 1, dead: 1 });
    expect(res.body.jobs.dead).toBe(1);
    expect(res.body.jobs.recent.map((j: { id: string }) => j.id)).toEqual([deadJob]);
    expect(res.body.integrations).toMatchObject({ failing: 1, degraded: 1 });
    expect(res.body.syncConflicts.open).toBe(1);
    expect(res.body.messages.failed).toBe(1);

    const other = await b.owner.get('/v1/ops/dashboard');
    expect(other.body).toMatchObject({ webhookEvents: { failed: 0, dead: 0 }, jobs: { failed: 0, dead: 0 }, integrations: { failing: 0 }, syncConflicts: { open: 0 }, messages: { failed: 0 } });

    const stylist = await createStaffUserUnthrottled(a, 'stylist');
    expect((await stylist.api.get('/v1/ops/dashboard')).status).toBe(403);
    expect((await stylist.api.get('/v1/ops/jobs')).status).toBe(403);

    // DLQ listing never includes global (organization_id NULL) jobs; they cannot be touched by tenants
    const list = await a.owner.get('/v1/ops/jobs', { state: 'dead' });
    expect(list.body.items.map((j: { id: string }) => j.id)).toEqual([deadJob]);
    expect((await a.owner.post(`/v1/ops/jobs/${globalJob}/retry`)).status).toBe(404);
    expect((await b.owner.post(`/v1/ops/jobs/${deadJob}/retry`)).status).toBe(404);
    await withSystem((trx) => trx.deleteFrom('jobs').where('id', '=', globalJob).execute());
  });

  it('retries and cancels DLQ jobs', async () => {
    const t = await createTenantUnthrottled();
    const jobId = await asSystem(t.organizationId, async (ctx) => {
      const { enqueue } = await import('../../jobs/queue.js');
      return enqueue(ctx, { type: 'test.flaky', maxAttempts: 2 });
    });
    flakyShouldFail = true;
    await runJobsWithRetries(5, ['test.flaky']);
    const dead = await t.owner.get('/v1/ops/jobs', { state: 'dead', type: 'test.flaky' });
    expect(dead.body.items).toHaveLength(1);
    expect(dead.body.items[0]).toMatchObject({ id: jobId, attempts: 2 });
    expect(dead.body.items[0].last_error).toContain('一時的な障害');

    flakyShouldFail = false;
    const retried = await t.owner.post(`/v1/ops/jobs/${jobId}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ state: 'queued', attempts: 0 });
    expect((await t.owner.post(`/v1/ops/jobs/${jobId}/retry`)).status).toBe(422); // already queued
    await runJobs();
    const row = await withSystem((trx) => trx.selectFrom('jobs').select(['state', 'attempts']).where('id', '=', jobId!).executeTakeFirstOrThrow());
    expect(row).toMatchObject({ state: 'succeeded', attempts: 1 });
    const audits = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('audit_logs').select('action').where('resource_id', '=', jobId!).execute());
    expect(audits.map((x) => x.action)).toEqual(['job.retry']);

    const deadJob = await insertJob(t.organizationId);
    const cancelled = await t.owner.post(`/v1/ops/jobs/${deadJob}/cancel`);
    expect(cancelled.body.state).toBe('cancelled');
    expect((await t.owner.post(`/v1/ops/jobs/${deadJob}/cancel`)).status).toBe(422);
  });

  it('lists and reprocesses webhook events', async () => {
    const t = await createTenantUnthrottled();
    const other = await createTenantUnthrottled();
    const dead = await insertWebhookEvent(t.organizationId);
    const forged = await insertWebhookEvent(t.organizationId, { signature_valid: false, status: 'ignored' });
    await insertWebhookEvent(other.organizationId);

    const list = await t.owner.get('/v1/ops/webhook-events', { status: 'dead' });
    expect(list.body.items.map((e: { id: string }) => e.id)).toEqual([dead]);
    expect((await other.owner.post(`/v1/ops/webhook-events/${dead}/reprocess`)).status).toBe(404);
    expect((await t.owner.post(`/v1/ops/webhook-events/${forged}/reprocess`)).status).toBe(422);

    const r = await t.owner.post(`/v1/ops/webhook-events/${dead}/reprocess`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'received', attempts: 0 });
    await runJobs();
    const ev = await withSystem((trx) => trx.selectFrom('webhook_events').select(['status', 'event_id']).where('id', '=', dead).executeTakeFirstOrThrow());
    expect(ev.status).toBe('processed');
    expect(reprocessed).toContain(`${t.organizationId}:${ev.event_id}`);
    expect((await t.owner.post(`/v1/ops/webhook-events/${dead}/reprocess`)).status).toBe(422);
  });

  it('reports queue health', async () => {
    const t = await createTenantUnthrottled();
    await insertJob(t.organizationId, { state: 'queued', attempts: 0, finished_at: null, run_at: new Date(Date.now() + DAY), type: 'test.later' });
    const res = await t.owner.get('/v1/ops/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ db: { ok: true }, queue: { queued: 1, ready: 0 } });
    expect(typeof res.body.workerLagSec).toBe('number');
    expect(res.body.oldestQueuedAgeSec).toBeGreaterThanOrEqual(0);
    const stylist = await createStaffUserUnthrottled(t, 'stylist');
    expect((await stylist.api.get('/v1/ops/health')).status).toBe(403);
    await withSystem((trx) => trx.deleteFrom('jobs').where('type', '=', 'test.later').execute());
  });
});

describe('audit log search', () => {
  it('filters by action/resource/actor/time with cursor pagination and actor names', async () => {
    const t = await createTenantUnthrottled();
    const reception = await createStaffUserUnthrottled(t, 'reception', { displayName: '受付 花子' });
    const c1 = await createCustomer(t, { lastName: '監査', firstName: '一郎' });
    const before = new Date().toISOString();
    await reception.api.get(`/v1/customers/${c1.id}`); // customer.view by reception
    await t.owner.patch(`/v1/customers/${c1.id}`, { firstName: '二郎' });

    const all = await t.owner.get('/v1/audit-logs', { resourceType: 'customer', resourceId: c1.id });
    expect(all.status).toBe(200);
    expect(all.body.items.map((i: { action: string }) => i.action)).toEqual(['customer.update', 'customer.view', 'customer.create']);
    const view = all.body.items.find((i: { action: string }) => i.action === 'customer.view');
    expect(view).toMatchObject({ actor_type: 'staff', actor_id: reception.staffId, actor_name: '受付 花子' });

    const byActor = await t.owner.get('/v1/audit-logs', { actorId: reception.staffId, action: 'customer.*' });
    expect(byActor.body.items.map((i: { action: string }) => i.action)).toEqual(['customer.view']);
    const since = await t.owner.get('/v1/audit-logs', { resourceId: c1.id, from: before });
    expect(since.body.items).toHaveLength(2);
    const until = await t.owner.get('/v1/audit-logs', { resourceId: c1.id, to: before });
    expect(until.body.items.map((i: { action: string }) => i.action)).toEqual(['customer.create']);

    const p1 = await t.owner.get('/v1/audit-logs', { resourceId: c1.id, limit: 2 });
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await t.owner.get('/v1/audit-logs', { resourceId: c1.id, limit: 2, cursor: p1.body.nextCursor });
    expect(p2.body.items.map((i: { action: string }) => i.action)).toEqual(['customer.create']);
    expect(p2.body.nextCursor).toBeNull();

    // searching is itself audited
    const searches = await t.owner.get('/v1/audit-logs', { action: 'audit_log.search' });
    expect(searches.body.items.length).toBeGreaterThanOrEqual(6);

    expect((await reception.api.get('/v1/audit-logs')).status).toBe(403);
    const other = await createTenantUnthrottled();
    expect((await other.owner.get('/v1/audit-logs', { resourceId: c1.id })).body.items).toHaveLength(0);
  });
});

async function readExport(t: Tenant, exportId: string, client = t.owner) {
  const dl = await client.get(`/v1/exports/${exportId}/download`);
  expect(dl.status).toBe(200);
  const token = (dl.body.url as string).split('/v1/files/blob/')[1]!;
  const payload = verifyLocalBlobToken(token);
  expect(payload).toMatchObject({ op: 'get' });
  return { csv: (await storage.get(payload!.k)).toString('utf8'), dl: dl.body };
}

describe('data exports', () => {
  it('exports customers to CSV end-to-end with audit and a short-lived download URL', async () => {
    const t = await createTenantUnthrottled();
    await createCustomer(t, { lastName: '山田', firstName: '太郎', phone: '090-1234-5678' });
    await createCustomer(t, { lastName: '鈴木', firstName: '花子' });
    await createCustomer(t, { lastName: '=HYPERLINK("x")', firstName: '攻撃' });

    const req = await t.owner.post('/v1/exports', { kind: 'customers' });
    expect(req.status).toBe(202);
    expect(req.body).toMatchObject({ kind: 'customers', status: 'queued' });
    expect(req.body.params).not.toHaveProperty('scope');
    expect((await t.owner.get(`/v1/exports/${req.body.id}/download`)).status).toBe(422); // not ready
    await runJobs();

    const done = await t.owner.get(`/v1/exports/${req.body.id}`);
    expect(done.body).toMatchObject({ status: 'completed', row_count: 3 });
    expect(new Date(done.body.expires_at).getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    const { csv, dl } = await readExport(t, req.body.id);
    expect(dl.fileName).toMatch(/^customers-\d{8}\.csv$/);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toContain('顧客番号,姓,名');
    expect(lines).toHaveLength(4);
    expect(csv).toContain('山田,太郎');
    expect(csv).toContain('090-1234-5678');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`); // formula injection neutralized

    const file = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('files').select(['purpose', 'status', 'object_key']).where('id', '=', done.body.file_id).executeTakeFirstOrThrow());
    expect(file).toMatchObject({ purpose: 'export', status: 'uploaded' });
    expect(file.object_key.startsWith(`${t.organizationId}/exports/`)).toBe(true);
    const audits = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('audit_logs').select(['action', 'metadata']).where('resource_id', '=', req.body.id).orderBy('id').execute());
    expect(audits.map((a) => a.action)).toEqual(['export.request', 'export.csv', 'export.download']);
    expect(audits[1]!.metadata).toMatchObject({ kind: 'customers', rowCount: 3, requestedBy: t.ownerStaffId });
    const events = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('domain_events').select('payload').where('event_type', '=', 'export.completed').execute());
    expect(events[0]!.payload).toMatchObject({ exportId: req.body.id, rowCount: 3 });

    expect((await t.owner.get('/v1/exports')).body.items).toHaveLength(1);
  });

  it('enforces permissions: export.data + domain permission; only the requester or audit.read may download', async () => {
    const t = await createTenantUnthrottled();
    const stylist = await createStaffUserUnthrottled(t, 'stylist');
    expect((await stylist.api.post('/v1/exports', { kind: 'customers' })).status).toBe(403);
    const accountant = await createStaffUserUnthrottled(t, 'accountant');
    expect((await accountant.api.post('/v1/exports', { kind: 'customers' })).status).toBe(403); // no customer.read

    await t.owner.post('/v1/roles', { key: 'exporter', name: 'エクスポート担当', permissions: ['export.data', 'customer.read', 'scope.all_shops'] });
    const exporter = await createStaffUserUnthrottled(t, 'exporter');
    const own = await exporter.api.post('/v1/exports', { kind: 'customers' });
    expect(own.status).toBe(202);
    const owners = await t.owner.post('/v1/exports', { kind: 'customers' });
    await runJobs();
    // exporter sees only their own export
    const mine = await exporter.api.get('/v1/exports');
    expect(mine.body.items.map((e: { id: string }) => e.id)).toEqual([own.body.id]);
    expect((await exporter.api.get(`/v1/exports/${owners.body.id}/download`)).status).toBe(404);
    expect((await exporter.api.get(`/v1/exports/${own.body.id}/download`)).status).toBe(200);
    // audit.read can download anyone's
    expect((await accountant.api.get(`/v1/exports/${own.body.id}/download`)).status).toBe(200);
    // other tenant
    const other = await createTenantUnthrottled();
    expect((await other.owner.get(`/v1/exports/${own.body.id}`)).status).toBe(404);

    // expired
    await asSystem(t.organizationId, (ctx) => ctx.trx.updateTable('data_exports').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', own.body.id).execute());
    const expired = await exporter.api.get(`/v1/exports/${own.body.id}/download`);
    expect(expired.status).toBe(422);
    expect(expired.body.error.code).toBe('EXPORT_EXPIRED');
  });

  it("respects the requester's shop scope for appointments and exports sales", async () => {
    const t = await createTenantUnthrottled();
    const shopB = await t.owner.post('/v1/shops', { name: '二号店', slug: `b-${randomUUID().slice(0, 8)}` });
    expect(shopB.status).toBe(201);
    const shopBId = shopB.body.id as string;
    const stylistA = await createStaffUserUnthrottled(t, 'stylist', { displayName: 'A店スタイリスト' });
    const stylistB = await createStaffUserUnthrottled(t, 'stylist', { displayName: 'B店スタイリスト', shopIds: [shopBId] });
    const managerB = await createStaffUserUnthrottled(t, 'manager', { shopIds: [shopBId] });
    const menu = await createMenu(t, { durationMin: 60 });
    const date = nextWeekday(3);
    const a1 = await t.owner.post('/v1/appointments', { shopId: t.shopId, staffId: stylistA.staffId, startAt: jst(date, '11:00'), menuIds: [menu.id] });
    const b1 = await t.owner.post('/v1/appointments', { shopId: shopBId, staffId: stylistB.staffId, startAt: jst(date, '11:00'), menuIds: [menu.id], allowOutsideSchedule: true });
    expect(a1.status).toBe(201);
    expect(b1.status).toBe(201);

    const forbidden = await managerB.api.post('/v1/exports', { kind: 'appointments', params: { shopId: t.shopId } });
    expect(forbidden.status).toBe(403);
    const mgr = await managerB.api.post('/v1/exports', { kind: 'appointments', params: { from: date, to: date } });
    const all = await t.owner.post('/v1/exports', { kind: 'appointments', params: { from: date, to: date } });
    await runJobs();
    const mgrCsv = (await readExport(t, mgr.body.id, managerB.api)).csv;
    expect(mgrCsv).toContain('二号店');
    expect(mgrCsv).not.toContain('本店');
    expect(mgrCsv).toContain('B店スタイリスト');
    expect((await t.owner.get(`/v1/exports/${mgr.body.id}`)).body.row_count).toBe(1);
    expect((await t.owner.get(`/v1/exports/${all.body.id}`)).body.row_count).toBe(2);

    // sales: completed transaction with staff allocation
    await asSystem(t.organizationId, async (ctx) => {
      const tx = await ctx.trx
        .insertInto('transactions')
        .values({ organization_id: t.organizationId, shop_id: t.shopId, status: 'completed', transaction_number: 'T-0001', subtotal: 5500, tax_total: 500, total: 5500, paid_total: 5500, completed_at: new Date(`${date}T03:00:00Z`) })
        .returning('id')
        .executeTakeFirstOrThrow();
      const item = await ctx.trx
        .insertInto('transaction_items')
        .values({ organization_id: t.organizationId, transaction_id: tx.id, item_type: 'service', menu_id: menu.id, name: 'カット', unit_price: 5500, amount: 5500, tax_amount: 500 })
        .returning('id')
        .executeTakeFirstOrThrow();
      await ctx.trx.insertInto('transaction_item_staff').values({ organization_id: t.organizationId, transaction_item_id: item.id, staff_id: stylistA.staffId, share_bp: 10000, allocated_amount: 5500, is_nominated: true }).execute();
    });
    const tx = await t.owner.post('/v1/exports', { kind: 'transactions', params: { from: date, to: date } });
    const items = await t.owner.post('/v1/exports', { kind: 'transaction_items' });
    const staffSales = await t.owner.post('/v1/exports', { kind: 'staff_sales', params: { from: date, to: date } });
    const mgrSales = await managerB.api.post('/v1/exports', { kind: 'staff_sales' });
    await runJobs();
    expect((await readExport(t, tx.body.id)).csv).toContain('T-0001');
    const itemsCsv = (await readExport(t, items.body.id)).csv;
    expect(itemsCsv).toContain('カット');
    expect(itemsCsv).toContain('A店スタイリスト');
    const salesCsv = (await readExport(t, staffSales.body.id)).csv;
    expect(salesCsv).toContain('スタッフ,店舗,技術売上');
    expect(salesCsv).toMatch(/A店スタイリスト,.*本店,5500,0,0,5500,1,1/);
    expect((await t.owner.get(`/v1/exports/${mgrSales.body.id}`)).body.row_count).toBe(0);
  });
});

describe('feature flags', () => {
  it('lists global defaults and applies org overrides', async () => {
    const t = await createTenantUnthrottled();
    const other = await createTenantUnthrottled();
    const list = await t.owner.get('/v1/feature-flags');
    expect(list.status).toBe(200);
    const keys = list.body.map((f: { key: string }) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['ai_assist', 'ec_store', 'external_sync', 'campaign_approval_required']));
    expect(list.body.find((f: { key: string }) => f.key === 'external_sync')).toMatchObject({ enabled: true, override: null });

    const check = (tenant: Tenant, key: string) => asSystem(tenant.organizationId, (ctx) => isFeatureEnabled(ctx, key));
    expect(await check(t, 'ai_assist')).toBe(false);
    const put = await t.owner.put('/v1/feature-flags/ai_assist', { enabled: true });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ key: 'ai_assist', enabled: true, global: { enabled: false }, override: { enabled: true } });
    expect(await check(t, 'ai_assist')).toBe(true);
    expect(await check(other, 'ai_assist')).toBe(false);
    expect(await check(t, 'unknown_flag')).toBe(false);
    expect(await asSystem(t.organizationId, (ctx) => isFeatureEnabled(ctx, 'unknown_flag2', true))).toBe(true);

    // global rows are read-only to tenants; unknown keys rejected
    expect((await t.owner.put('/v1/feature-flags/brand_new_flag', { enabled: true })).status).toBe(404);
    const globals = await withSystem((trx) => trx.selectFrom('feature_flags').select('enabled').where('organization_id', 'is', null).where('key', '=', 'ai_assist').executeTakeFirstOrThrow());
    expect(globals.enabled).toBe(false);

    const reset = await t.owner.delete('/v1/feature-flags/ai_assist');
    expect(reset.body).toMatchObject({ enabled: false, override: null });
    expect(await check(t, 'ai_assist')).toBe(false);

    const audits = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('audit_logs').select('action').where('resource_type', '=', 'feature_flag').execute());
    expect(audits.map((a) => a.action)).toEqual(['feature_flag.update', 'feature_flag.reset']);
    const stylist = await createStaffUserUnthrottled(t, 'stylist');
    expect((await stylist.api.put('/v1/feature-flags/ai_assist', { enabled: true })).status).toBe(403);
    clearFeatureFlagCache();
  });

  it('percentage rollout is stable per organization', () => {
    const rows = [{ organization_id: null, enabled: true, rollout: { percentage: 50 } }];
    const results = Array.from({ length: 200 }, () => evaluateFlag(randomUUID(), 'x', rows, false));
    const on = results.filter(Boolean).length;
    expect(on).toBeGreaterThan(50);
    expect(on).toBeLessThan(150);
    const org = randomUUID();
    expect(evaluateFlag(org, 'x', rows, false)).toBe(evaluateFlag(org, 'x', rows, false));
    expect(evaluateFlag(org, 'x', [...rows, { organization_id: org, enabled: false, rollout: {} }], true)).toBe(false);
  });
});

describe('retention cleanup', () => {
  it('purges expired operational data and anonymizes long-deleted customers', async () => {
    expect(registeredPeriodicTasks().some((p) => p.name === 'ops.retention')).toBe(true);
    const t = await createTenantUnthrottled();
    const short = await createTenantUnthrottled();
    await short.owner.patch('/v1/organization', { settings: { retentionDays: 30 } });
    const now = Date.now();

    const oldCustomer = await createCustomer(t, { lastName: '古川', firstName: '退会', phone: '090-9999-0000', email: 'old@example.com', address: '東京都', birthday: '1990-01-01', attributes: { allergy: 'あり' } });
    const recentCustomer = await createCustomer(t, { lastName: '新井', firstName: '退会', phone: '090-9999-1111' });
    const shortCustomer = await createCustomer(short, { lastName: '短期', firstName: '保持' });
    const ids = await asSystem(t.organizationId, async (ctx) => {
      await ctx.trx.updateTable('customers').set({ deleted_at: new Date(now - 400 * DAY), status: 'deleted' }).where('id', '=', oldCustomer.id).execute();
      await ctx.trx.updateTable('customers').set({ deleted_at: new Date(now - 10 * DAY), status: 'deleted' }).where('id', '=', recentCustomer.id).execute();
      await ctx.trx.insertInto('customer_identities').values({ organization_id: t.organizationId, customer_id: oldCustomer.id, provider: 'line', external_id: `U${randomUUID()}` }).execute();
      const idem = await ctx.trx
        .insertInto('idempotency_keys')
        .values([
          { organization_id: t.organizationId, key: 'old', scope: 's', request_hash: 'h', expires_at: new Date(now - DAY) },
          { organization_id: t.organizationId, key: 'new', scope: 's', request_hash: 'h', expires_at: new Date(now + DAY) },
        ])
        .returning(['id', 'key'])
        .execute();
      return { idem };
    });
    await asSystem(short.organizationId, (ctx) => ctx.trx.updateTable('customers').set({ deleted_at: new Date(now - 40 * DAY), status: 'deleted' }).where('id', '=', shortCustomer.id).execute());
    const oldJob = await insertJob(t.organizationId, { state: 'succeeded', finished_at: new Date(now - 20 * DAY), type: 'test.old' });
    const newJob = await insertJob(t.organizationId, { state: 'succeeded', finished_at: new Date(now - DAY), type: 'test.old' });
    const deadJob = await insertJob(t.organizationId, { finished_at: new Date(now - 20 * DAY) });
    const otp = await withSystem((trx) =>
      trx
        .insertInto('otp_challenges')
        .values([
          { organization_id: t.organizationId, purpose: 'customer_login', channel: 'sms', destination: 'x', code_hash: 'h', expires_at: new Date(now - 9 * DAY), created_at: new Date(now - 10 * DAY), consumed_at: new Date(now - 10 * DAY) },
          { organization_id: t.organizationId, purpose: 'customer_login', channel: 'sms', destination: 'y', code_hash: 'h', expires_at: new Date(now + DAY) },
        ])
        .returning('id')
        .execute(),
    );
    const oldHook = await insertWebhookEvent(t.organizationId, { status: 'processed', received_at: new Date(now - 100 * DAY) });
    const oldFailedHook = await insertWebhookEvent(t.organizationId, { status: 'failed', received_at: new Date(now - 100 * DAY) });
    const freshHook = await insertWebhookEvent(t.organizationId, { status: 'processed' });

    // expired export with a stored object
    const objectKey = `${t.organizationId}/exports/${randomUUID()}/customers-old.csv`;
    await storage.put(objectKey, Buffer.from('a,b\r\n'), 'text/csv');
    const exportId = await asSystem(t.organizationId, async (ctx) => {
      const file = await ctx.trx.insertInto('files').values({ organization_id: t.organizationId, object_key: objectKey, purpose: 'export', content_type: 'text/csv', status: 'uploaded' }).returning('id').executeTakeFirstOrThrow();
      const exp = await ctx.trx
        .insertInto('data_exports')
        .values({ organization_id: t.organizationId, kind: 'customers', status: 'completed', file_id: file.id, requested_by: t.ownerStaffId, row_count: 1, expires_at: new Date(now - DAY) })
        .returning('id')
        .executeTakeFirstOrThrow();
      return exp.id;
    });
    const auditBefore = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('audit_logs').select('id').where('resource_id', '=', oldCustomer.id).execute());

    const stats = await runRetention();
    expect(stats.customersAnonymized).toBeGreaterThanOrEqual(2);
    expect(stats.exportsExpired).toBeGreaterThanOrEqual(1);

    const idemLeft = await withSystem((trx) => trx.selectFrom('idempotency_keys').select('key').where('id', 'in', ids.idem.map((i) => i.id)).execute());
    expect(idemLeft.map((r) => r.key)).toEqual(['new']);
    const jobsLeft = await withSystem((trx) => trx.selectFrom('jobs').select('id').where('id', 'in', [oldJob, newJob, deadJob]).execute());
    expect(jobsLeft.map((j) => j.id).sort()).toEqual([newJob, deadJob].sort()); // DLQ is never auto-purged
    const otpLeft = await withSystem((trx) => trx.selectFrom('otp_challenges').select('id').where('id', 'in', otp.map((o) => o.id)).execute());
    expect(otpLeft.map((o) => o.id)).toEqual([otp[1]!.id]);
    const hooksLeft = await withSystem((trx) => trx.selectFrom('webhook_events').select('id').where('id', 'in', [oldHook, oldFailedHook, freshHook]).execute());
    expect(hooksLeft.map((h) => h.id).sort()).toEqual([oldFailedHook, freshHook].sort());

    const exp = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('data_exports').innerJoin('files', 'files.id', 'data_exports.file_id').select(['data_exports.status', 'files.status as file_status']).where('data_exports.id', '=', exportId).executeTakeFirstOrThrow(),
    );
    expect(exp).toMatchObject({ status: 'expired', file_status: 'deleted' });
    expect(await storage.head(objectKey)).toBeNull();

    const anon = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('customers').selectAll().where('id', 'in', [oldCustomer.id, recentCustomer.id]).execute());
    const o = anon.find((c) => c.id === oldCustomer.id)!;
    expect(o).toMatchObject({ last_name: '削除済み', first_name: '', phone: null, phone_normalized: null, email: null, address: null, birthday: null });
    expect(o.attributes).toHaveProperty('anonymizedAt');
    expect(o.attributes).not.toHaveProperty('allergy');
    const r = anon.find((c) => c.id === recentCustomer.id)!;
    expect(r.last_name).toBe('新井');
    const identities = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('customer_identities').select('id').where('customer_id', '=', oldCustomer.id).execute());
    expect(identities).toHaveLength(0);
    const shortRow = await asSystem(short.organizationId, (ctx) => ctx.trx.selectFrom('customers').select('last_name').where('id', '=', shortCustomer.id).executeTakeFirstOrThrow());
    expect(shortRow.last_name).toBe('削除済み');
    // audit trail untouched, anonymization itself audited
    const auditAfter = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('audit_logs').select('id').where('resource_id', '=', oldCustomer.id).execute());
    expect(auditAfter).toHaveLength(auditBefore.length);
    const anonAudit = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('audit_logs').select('metadata').where('action', '=', 'customer.anonymize').execute());
    expect(anonAudit[0]!.metadata).toMatchObject({ count: 1, retentionDays: 365 });

    // idempotent second run
    const again = await runRetention();
    expect(again.customersAnonymized).toBe(0);
  });
});
