import { DateTime } from 'luxon';
import { afterEach, describe, expect, it } from 'vitest';
import { withSystem } from '../../db/tenant.js';
import { enqueue } from '../../jobs/queue.js';
import { registeredPeriodicTasks } from '../../jobs/scheduler.js';
import { mockOutbox } from '../../lib/mailer.js';
import {
  asSystem,
  createCustomer,
  createMenu,
  createStaffUser,
  createTenant,
  daysAgo,
  jst,
  jstDate,
  nextWeekday,
  runJobs,
  setClock,
  updateCustomer,
  type Tenant,
} from '../../test/helpers.js';

afterEach(() => setClock(null));

let n = 0;
async function emailCustomer(t: Tenant, patch: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
  n++;
  const email = `auto-${Date.now()}-${n}@example.com`;
  const c = await createCustomer(t, { email, ...body });
  if (Object.keys(patch).length) await updateCustomer(t, c.id, patch);
  return { id: c.id, email };
}

async function fanout() {
  await withSystem((trx) => enqueue(trx, { type: 'automation.fanout', organizationId: null }));
  await runJobs();
}

function runsOf(t: Tenant, automationId: string) {
  return asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('automation_runs').selectAll().where('automation_id', '=', automationId).orderBy('created_at').execute());
}

async function createAutomation(t: Tenant, body: Record<string, unknown>) {
  const res = await t.owner.post('/v1/automations', { name: '自動配信', channel: 'email', isActive: true, ...body });
  if (res.status !== 201) throw new Error(`automation create failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string };
}

describe('automations', () => {
  it('registers the daily periodic fan-out at 10:00 JST', () => {
    const task = registeredPeriodicTasks().find((p) => p.name === 'messaging.automations.daily');
    expect(task?.jobType).toBe('automation.fanout');
    expect(task!.bucket(new Date('2026-10-01T00:30:00Z'))).toBeNull(); // 09:30 JST
    expect(task!.bucket(new Date('2026-10-01T01:05:00Z'))).toBe('2026-10-01'); // 10:05 JST
  });

  it('days_since_last_visit (休眠) sends once per visit cycle', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    const menu = await createMenu(t);
    const dormant = await emailCustomer(t, { last_visit_at: daysAgo(50), visit_count: 2 });
    await emailCustomer(t, { last_visit_at: daysAgo(10), visit_count: 2 });
    const booked = await emailCustomer(t);
    await t.owner.post('/v1/appointments', { shopId: t.shopId, customerId: booked.id, staffId: stylist.staffId, startAt: jst(nextWeekday(3), '12:00'), menuIds: [menu.id] });
    await updateCustomer(t, booked.id, { last_visit_at: daysAgo(80), visit_count: 2 });
    await emailCustomer(t, { last_visit_at: daysAgo(90), visit_count: 2 }, { marketingOptIn: false });

    const a = await createAutomation(t, { triggerType: 'days_since_last_visit', config: { days: 45 } });
    const dry = await t.owner.post(`/v1/automations/${a.id}/dry-run`);
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ candidates: 1, alreadySent: 0 });
    expect(dry.body.sample[0].id).toBe(dormant.id);

    await fanout();
    const runs = await runsOf(t, a.id);
    expect(runs).toHaveLength(1);
    const lastVisitDate = DateTime.fromJSDate(daysAgo(50), { zone: 'Asia/Tokyo' }).toISODate();
    expect(runs[0]).toMatchObject({ customer_id: dormant.id, dedupe_key: `${a.id}:${dormant.id}:${lastVisitDate}` });
    expect(runs[0]!.message_id).toBeTruthy();
    const mail = mockOutbox.filter((m) => m.to === dormant.email);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe('【テストサロン 本店】お久しぶりです');
    expect(mail[0]!.text).toContain('配信停止');
    const msg = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('messages').selectAll().where('id', '=', runs[0]!.message_id!).executeTakeFirstOrThrow());
    expect(msg).toMatchObject({ automation_id: a.id, category: 'marketing', status: 'sent' });

    // the next daily run does not message the same cycle again
    await fanout();
    expect(await runsOf(t, a.id)).toHaveLength(1);
    expect(mockOutbox.filter((m) => m.to === dormant.email)).toHaveLength(1);
    expect((await t.owner.post(`/v1/automations/${a.id}/dry-run`)).body).toMatchObject({ candidates: 0, alreadySent: 1 });

    // a new visit starts a new cycle → eligible again once dormant
    await updateCustomer(t, dormant.id, { last_visit_at: daysAgo(46) });
    await fanout();
    expect(await runsOf(t, a.id)).toHaveLength(2);
    expect(mockOutbox.filter((m) => m.to === dormant.email)).toHaveLength(2);
    const detail = await t.owner.get(`/v1/automations/${a.id}`);
    expect(detail.body.stats).toEqual({ runs: 2, sent: 2 });
    expect(detail.body.last_run_at).not.toBeNull();
  });

  it('evaluates no_return_after_first_visit, visit_cycle_due, after_visit and birthday_month', async () => {
    const t = await createTenant();
    const firstOnly = await emailCustomer(t, { first_visit_at: daysAgo(70), last_visit_at: daysAgo(70), visit_count: 1 });
    await emailCustomer(t, { first_visit_at: daysAgo(20), last_visit_at: daysAgo(20), visit_count: 1 });
    const cycleDue = await emailCustomer(t, { first_visit_at: daysAgo(100), last_visit_at: daysAgo(35), visit_count: 3, avg_cycle_days: 30 });
    await emailCustomer(t, { first_visit_at: daysAgo(100), last_visit_at: daysAgo(10), visit_count: 3, avg_cycle_days: 30 });
    const afterVisit = await emailCustomer(t, { first_visit_at: daysAgo(4), last_visit_at: daysAgo(4), visit_count: 2 });
    const month = DateTime.now().setZone('Asia/Tokyo').month;
    const bday = await emailCustomer(t, {}, { birthday: `1992-${String(month).padStart(2, '0')}-10` });

    const noReturn = await createAutomation(t, { triggerType: 'no_return_after_first_visit', config: { days: 60 } });
    const cycle = await createAutomation(t, { triggerType: 'visit_cycle_due', config: { offsetDays: 0 } });
    const after = await createAutomation(t, { triggerType: 'after_visit', config: { days: 3 } });
    const birthday = await createAutomation(t, { triggerType: 'birthday_month', config: {} });

    const sampleOf = async (id: string) => (await t.owner.post(`/v1/automations/${id}/dry-run`)).body.sample.map((s: { id: string }) => s.id);
    expect(await sampleOf(noReturn.id)).toEqual([firstOnly.id]);
    expect(await sampleOf(cycle.id)).toEqual([cycleDue.id]);
    expect(await sampleOf(after.id)).toEqual([afterVisit.id]);
    expect(await sampleOf(birthday.id)).toEqual([bday.id]);

    await fanout();
    const subjects = (email: string) => mockOutbox.filter((m) => m.to === email).map((m) => m.subject);
    expect(subjects(firstOnly.email)).toEqual(['【テストサロン 本店】初めてのご来店ありがとうございました']);
    expect(subjects(cycleDue.email)).toEqual(['【テストサロン 本店】お久しぶりです']);
    expect(subjects(afterVisit.email)).toEqual(['【テストサロン 本店】先日はご来店ありがとうございました']);
    expect(subjects(bday.email)).toEqual(['【テストサロン 本店】お誕生日おめでとうございます']);
    const year = DateTime.now().setZone('Asia/Tokyo').year;
    expect((await runsOf(t, birthday.id))[0]!.dedupe_key).toBe(`${birthday.id}:${bday.id}:${year}`);
    await fanout();
    expect(subjects(bday.email)).toHaveLength(1);
  });

  it('honours sendHour, segment narrowing, shop scope and inactive automations', async () => {
    const t = await createTenant();
    const shop2 = (await t.owner.post('/v1/shops', { name: '2号店', slug: `auto-${Date.now()}` })).body;
    const tag = (await t.owner.post('/v1/tags', { name: '休眠対象' })).body;
    const tagged = await emailCustomer(t, { last_visit_at: daysAgo(60) }, { primaryShopId: t.shopId });
    await t.owner.put(`/v1/customers/${tagged.id}/tags`, { tagIds: [tag.id] });
    await emailCustomer(t, { last_visit_at: daysAgo(60) }, { primaryShopId: t.shopId });
    const otherShop = await emailCustomer(t, { last_visit_at: daysAgo(60) }, { primaryShopId: shop2.id });
    await t.owner.put(`/v1/customers/${otherShop.id}/tags`, { tagIds: [tag.id] });

    const day = jstDate(3);
    setClock(new Date(`${day}T10:00:00+09:00`));
    const a = await createAutomation(t, { shopId: t.shopId, triggerType: 'days_since_last_visit', config: { days: 45, sendHour: 18, segmentRule: { type: 'tag', tagIds: [tag.id] } } });
    const inactive = await createAutomation(t, { triggerType: 'days_since_last_visit', config: { days: 1 }, isActive: false });
    await fanout();
    const runs = await runsOf(t, a.id);
    expect(runs.map((r) => r.customer_id)).toEqual([tagged.id]);
    const msg = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('messages').selectAll().where('id', '=', runs[0]!.message_id!).executeTakeFirstOrThrow());
    expect(msg.status).toBe('queued');
    expect(msg.scheduled_at?.toISOString()).toBe(new Date(`${day}T18:00:00+09:00`).toISOString());
    expect(msg.shop_id).toBe(t.shopId);
    expect(await runsOf(t, inactive.id)).toHaveLength(0);
  });

  it('CRUD with validation, permissions and tenant isolation', async () => {
    const t = await createTenant();
    const other = await createTenant();
    const tpl = await t.owner.post('/v1/message-templates', { name: '休眠用', channel: 'line', category: 'marketing', body: '{{customer.name}}様 お元気ですか' });
    const a = await createAutomation(t, { triggerType: 'days_since_last_visit', config: { days: 60, requireNoFutureAppointment: false }, templateId: tpl.body.id, channel: 'line', isActive: false });
    expect((await t.owner.get('/v1/automations')).body).toHaveLength(1);
    const upd = await t.owner.patch(`/v1/automations/${a.id}`, { isActive: true, config: { days: 30 } });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ is_active: true, config: { days: 30 } });
    expect((await t.owner.post('/v1/automations', { name: 'x', triggerType: 'days_since_last_visit', config: { unknown: 1 } })).status).toBe(400);
    expect((await t.owner.post('/v1/automations', { name: 'x', triggerType: 'visit_cycle_due', config: { days: 3 } })).status).toBe(400);
    expect((await t.owner.post('/v1/automations', { name: 'x', triggerType: 'nope' })).status).toBe(400);
    expect((await t.owner.post('/v1/automations', { name: 'x', triggerType: 'after_visit', config: { segmentRule: { type: 'bad' } } })).status).toBe(400);

    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.get('/v1/automations')).status).toBe(403);
    expect((await stylist.api.post(`/v1/automations/${a.id}/dry-run`)).status).toBe(403);
    expect((await other.owner.get(`/v1/automations/${a.id}`)).status).toBe(404);
    expect((await other.owner.patch(`/v1/automations/${a.id}`, { isActive: false })).status).toBe(404);
    expect((await other.owner.get('/v1/automations')).body).toHaveLength(0);

    // automations with history are deactivated instead of deleted
    const c = await emailCustomer(t, { last_visit_at: daysAgo(40) });
    void c;
    await asSystem(t.organizationId, async (ctx) => {
      const { runAutomation } = await import('./automations.js');
      await runAutomation(ctx, a.id);
    });
    const del = await t.owner.delete(`/v1/automations/${a.id}`);
    expect(del.body).toEqual({ ok: true, deactivatedOnly: true });
    expect((await t.owner.get(`/v1/automations/${a.id}`)).body.is_active).toBe(false);
    const fresh = await createAutomation(t, { triggerType: 'birthday_month', isActive: false });
    expect((await t.owner.delete(`/v1/automations/${fresh.id}`)).body).toEqual({ ok: true, deactivatedOnly: false });
    expect((await t.owner.get(`/v1/automations/${fresh.id}`)).status).toBe(404);
  });
});
