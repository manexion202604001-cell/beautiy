import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enqueue } from '../../jobs/queue.js';
import {
  asSystem,
  createCustomer,
  createLineChannel,
  createStaffUser,
  createTenant,
  jstDate,
  lineFollower,
  makeJobsDue,
  runJobs,
  setClock,
  updateCustomer,
  type Tenant,
} from '../../test/helpers.js';
import { lineMock } from './providers/line.js';

beforeEach(() => lineMock.reset());
afterEach(() => setClock(null));

const ALL = { type: 'visit_count', gte: 0 };

/** sends through this tenant's LINE channel only (the mock outbox is process-wide) */
function outboxOf(ch: { accessToken: string }) {
  return lineMock.outbox.filter((s) => s.accessToken === ch.accessToken);
}

async function audience(t: Tenant) {
  const ch = await createLineChannel(t);
  const followers = [await lineFollower(t, ch), await lineFollower(t, ch), await lineFollower(t, ch)];
  const emailOnly = await createCustomer(t, { email: `camp-${Date.now()}@example.com` });
  const optedOut = await lineFollower(t, ch);
  await updateCustomer(t, optedOut.customerId, { marketing_opt_in: false });
  return { ch, followers, emailOnly, optedOut };
}

function campaignMessages(t: Tenant, campaignId: string) {
  return asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('messages').selectAll().where('campaign_id', '=', campaignId).orderBy('id').execute());
}

describe('campaigns', () => {
  it('snapshots the segment, multicasts identical LINE texts in one batch and completes with stats', async () => {
    const t = await createTenant();
    const { ch, followers, emailOnly, optedOut } = await audience(t);
    const created = await t.owner.post('/v1/campaigns', { name: '春のキャンペーン', channel: 'line', segmentRule: ALL, body: '春のキャンペーンのお知らせです🌸' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'draft', approved_by: null });
    const id = created.body.id;
    // nothing is sent before an explicit schedule action
    await runJobs();
    expect(outboxOf(ch)).toHaveLength(0);

    const scheduled = await t.owner.post(`/v1/campaigns/${id}/schedule`, {});
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.status).toBe('scheduled');
    expect(scheduled.body.approved_by).toBe(t.ownerStaffId);
    await runJobs();

    const multicasts = outboxOf(ch).filter((s) => s.kind === 'multicast');
    expect(multicasts).toHaveLength(1);
    expect([...multicasts[0]!.to].sort()).toEqual(followers.map((f) => f.userId).sort());
    expect(multicasts[0]!.retryKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(multicasts[0]!.accessToken).toBe(ch.accessToken);
    expect(outboxOf(ch).filter((s) => s.kind === 'push')).toHaveLength(0);

    const detail = await t.owner.get(`/v1/campaigns/${id}`);
    expect(detail.body.status).toBe('completed');
    expect(detail.body.stats).toEqual({ targets: 5, queued: 0, sent: 3, failed: 0, skipped: 2, cancelled: 0 });
    const msgs = await campaignMessages(t, id);
    expect(msgs).toHaveLength(5);
    expect(msgs.every((m) => m.dedupe_key === `campaign:${id}:${m.customer_id}` && m.category === 'marketing')).toBe(true);
    expect(msgs.find((m) => m.customer_id === emailOnly.id)).toMatchObject({ status: 'skipped', skip_reason: 'no_line_identity' });
    expect(msgs.find((m) => m.customer_id === optedOut.customerId)).toMatchObject({ status: 'skipped', skip_reason: 'opted_out' });
    const stored = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('campaigns').select(['stats', 'completed_at']).where('id', '=', id).executeTakeFirstOrThrow());
    expect(stored.stats).toMatchObject({ targets: 5, sent: 3, skipped: 2 });
    expect(stored.completed_at).not.toBeNull();

    // re-running the snapshot (e.g. job retry) never duplicates messages
    await asSystem(t.organizationId, async (ctx) => {
      await ctx.trx.updateTable('campaigns').set({ status: 'scheduled' }).where('id', '=', id).execute();
      await enqueue(ctx, { type: 'campaign.run', payload: { campaignId: id } });
    });
    await runJobs();
    expect(await campaignMessages(t, id)).toHaveLength(5);
    expect(outboxOf(ch)).toHaveLength(1);
  });

  it('personalised templates are pushed per customer; saved segments are snapshotted at schedule time', async () => {
    const t = await createTenant();
    const { ch, followers } = await audience(t);
    for (const [i, f] of followers.entries()) await updateCustomer(t, f.customerId, { last_name: `顧客${i}`, first_name: '様子', visit_count: i });
    const segment = await t.owner.post('/v1/segments', { name: '来店1回以上', rule: { type: 'visit_count', gte: 5 } });
    const tpl = await t.owner.post('/v1/message-templates', { name: '限定クーポン', channel: 'line', category: 'marketing', body: '{{customer.lastName}}様 限定クーポンをお届けします' });
    const created = await t.owner.post('/v1/campaigns', { name: '限定', segmentId: segment.body.id, templateId: tpl.body.id });
    expect(created.status).toBe(201);
    // the segment changes after drafting → schedule uses the latest rule
    await t.owner.patch(`/v1/segments/${segment.body.id}`, { rule: { type: 'visit_count', gte: 1 } });
    await t.owner.post(`/v1/campaigns/${created.body.id}/schedule`, {});
    await runJobs();
    const pushes = outboxOf(ch).filter((s) => s.kind === 'push');
    expect(pushes).toHaveLength(2);
    const texts = pushes.map((p) => (p.messages[0] as { text: string }).text).sort();
    expect(texts).toEqual(['顧客1様 限定クーポンをお届けします', '顧客2様 限定クーポンをお届けします']);
    expect((await t.owner.get(`/v1/campaigns/${created.body.id}`)).body.stats).toMatchObject({ targets: 2, sent: 2 });
  });

  it('retries a failed multicast with the same retry key', async () => {
    const t = await createTenant();
    const { ch, followers } = await audience(t);
    const created = await t.owner.post('/v1/campaigns', { name: 'リトライ', segmentRule: { type: 'marketing_opt_in' }, body: '一斉配信' });
    lineMock.failNext('retry', 1, { to: followers[0]!.userId });
    await t.owner.post(`/v1/campaigns/${created.body.id}/schedule`, {});
    await runJobs();
    expect(outboxOf(ch)).toHaveLength(0);
    let detail = (await t.owner.get(`/v1/campaigns/${created.body.id}`)).body;
    expect(detail.status).toBe('running');
    expect(detail.stats.queued).toBe(3);
    await makeJobsDue(t, { type: 'line.multicast' });
    await runJobs();
    expect(outboxOf(ch)).toHaveLength(1);
    expect(outboxOf(ch)[0]!.to).toHaveLength(followers.length);
    await makeJobsDue(t, { type: 'campaign.stats' });
    await runJobs();
    detail = (await t.owner.get(`/v1/campaigns/${created.body.id}`)).body;
    expect(detail.stats).toMatchObject({ sent: 3, queued: 0 });
    expect(detail.status).toBe('completed');
  });

  it('cancels a scheduled campaign and the queued (quiet-hours deferred) messages of a running one', async () => {
    const t = await createTenant();
    const { ch } = await audience(t);
    const future = await t.owner.post('/v1/campaigns', { name: '来週', segmentRule: ALL, body: 'x' });
    const at = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const sch = await t.owner.post(`/v1/campaigns/${future.body.id}/schedule`, { scheduledAt: at });
    expect(sch.body.scheduled_at).toBe(at);
    const cancelled = await t.owner.post(`/v1/campaigns/${future.body.id}/cancel`);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelledMessages: 0 });
    const job = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('jobs').select('state').where('dedupe_key', '=', `campaign:${future.body.id}:run`).executeTakeFirstOrThrow());
    expect(job.state).toBe('cancelled');
    expect((await t.owner.post(`/v1/campaigns/${future.body.id}/cancel`)).status).toBe(422);

    // 22:30 local → marketing deferred to 09:00
    const day = jstDate(5);
    setClock(new Date(`${day}T22:30:00+09:00`));
    const night = await t.owner.post('/v1/campaigns', { name: '夜', segmentRule: ALL, body: '夜の配信' });
    await t.owner.post(`/v1/campaigns/${night.body.id}/schedule`, {});
    await makeJobsDue(t, { type: 'campaign.run' });
    await runJobs();
    const running = (await t.owner.get(`/v1/campaigns/${night.body.id}`)).body;
    expect(running.status).toBe('running');
    expect(running.stats).toMatchObject({ queued: 3, skipped: 2 });
    expect(outboxOf(ch)).toHaveLength(0);
    const res = await t.owner.post(`/v1/campaigns/${night.body.id}/cancel`);
    expect(res.body).toMatchObject({ status: 'cancelled', cancelledMessages: 3 });
    expect(res.body.stats).toMatchObject({ cancelled: 3, queued: 0 });
    const pending = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('jobs').select('id').where('type', '=', 'message.deliver').where('state', '=', 'queued').where('organization_id', '=', t.organizationId).execute(),
    );
    expect(pending).toHaveLength(0);
  });

  it('requires approval by another staff member or a manager when the organization demands it', async () => {
    const t = await createTenant();
    await asSystem(t.organizationId, (ctx) =>
      ctx.trx.updateTable('organizations').set({ settings: sql`settings || '{"messaging":{"requireCampaignApproval":true}}'::jsonb` }).where('id', '=', t.organizationId).execute(),
    );
    await t.owner.post('/v1/roles', { key: 'marketer', name: '販促担当', permissions: ['campaign.manage', 'customer.read', 'template.manage'] });
    const m1 = await createStaffUser(t, 'marketer');
    const m2 = await createStaffUser(t, 'marketer');
    const created = await m1.api.post('/v1/campaigns', { name: '承認テスト', shopId: t.shopId, segmentRule: ALL, body: 'x' });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const noApproval = await m1.api.post(`/v1/campaigns/${id}/schedule`, {});
    expect(noApproval.status).toBe(422);
    expect(noApproval.body.error.code).toBe('CAMPAIGN_APPROVAL_REQUIRED');
    const self = await m1.api.post(`/v1/campaigns/${id}/approve`);
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('APPROVAL_SELF_FORBIDDEN');
    const ok = await m2.api.post(`/v1/campaigns/${id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.approved_by).toBe(m2.staffId);
    // editing the content invalidates the approval
    const edited = await m1.api.patch(`/v1/campaigns/${id}`, { body: '修正版' });
    expect(edited.body.approved_by).toBeNull();
    expect((await m1.api.post(`/v1/campaigns/${id}/schedule`, {})).status).toBe(422);
    // owners/managers may approve (even their own)
    expect((await t.owner.post(`/v1/campaigns/${id}/approve`)).status).toBe(200);
    const sched = await m1.api.post(`/v1/campaigns/${id}/schedule`, { scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(sched.status).toBe(200);
    expect(sched.body.status).toBe('scheduled');
    expect((await m1.api.patch(`/v1/campaigns/${id}`, { name: 'x' })).status).toBe(422);
    expect((await m1.api.delete(`/v1/campaigns/${id}`)).status).toBe(422);
  });

  it('enforces permissions, shop scope, validation and tenant isolation', async () => {
    const t = await createTenant();
    const other = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.get('/v1/campaigns')).status).toBe(403);
    expect((await stylist.api.post('/v1/campaigns', { name: 'x', segmentRule: ALL, body: 'x' })).status).toBe(403);
    const manager = await createStaffUser(t, 'manager');
    expect((await manager.api.post('/v1/campaigns', { name: 'x', segmentRule: ALL, body: 'x' })).status).toBe(403);
    expect((await manager.api.post('/v1/campaigns', { name: 'x', shopId: t.shopId, segmentRule: ALL, body: 'x' })).status).toBe(201);
    expect((await t.owner.post('/v1/campaigns', { name: 'x', segmentRule: ALL })).status).toBe(400);
    expect((await t.owner.post('/v1/campaigns', { name: 'x', body: 'x' })).status).toBe(400);
    expect((await t.owner.post('/v1/campaigns', { name: 'x', body: 'x', segmentRule: { type: 'nope' } })).status).toBe(400);
    const c = await t.owner.post('/v1/campaigns', { name: '下書き', segmentRule: ALL, body: 'x' });
    expect((await t.owner.post(`/v1/campaigns/${c.body.id}/schedule`, { scheduledAt: '2020-01-01T00:00:00Z' })).status).toBe(400);
    expect((await other.owner.get(`/v1/campaigns/${c.body.id}`)).status).toBe(404);
    expect((await other.owner.post(`/v1/campaigns/${c.body.id}/schedule`, {})).status).toBe(404);
    expect((await other.owner.get('/v1/campaigns')).body.items).toHaveLength(0);
    const list = await t.owner.get('/v1/campaigns', { status: 'draft' });
    expect(list.body.items.length).toBe(2);
    expect((await t.owner.delete(`/v1/campaigns/${c.body.id}`)).status).toBe(204);
  });
});
