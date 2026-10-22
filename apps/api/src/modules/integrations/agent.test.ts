import { describe, expect, it } from 'vitest';
import { mockOutbox } from '../../lib/mailer.js';
import {
  api,
  asSystem,
  createCustomer,
  createMenu,
  createStaffUser,
  createTenant,
  jst,
  nextWeekday,
  runJobs,
} from '../../test/helpers.js';
import { runAgentWatchdog } from './agent.js';

const WED = 3;

async function setup() {
  const t = await createTenant();
  await t.owner.patch(`/v1/staff/${t.ownerStaffId}`, { isBookable: false });
  await t.owner.patch(`/v1/shops/${t.shopId}`, { email: 'front@salon.example' });
  const suzuna = await createStaffUser(t, 'stylist', { displayName: 'suzuna' });
  await createStaffUser(t, 'stylist', { displayName: 'yuri' });
  const cut = await createMenu(t, { name: 'カット', durationMin: 60 });
  const minimo = (
    await t.owner.post('/v1/integrations', {
      provider: 'minimo_mail',
      shopId: t.shopId,
      displayName: 'minimo',
      config: { pushBlocks: false, mail: { unknownStaffAsFree: true } },
    })
  ).body;
  const issued = await t.owner.post('/v1/integrations/agents', {
    shopId: t.shopId,
    name: 'Mac mini',
  });
  expect(issued.status).toBe(201);
  const token = issued.body.token as string;
  const helper = {
    plan: (body: unknown) =>
      api().post('/v1/agent/plan', body, { authorization: `Bearer ${token}` }),
    report: (body: unknown) =>
      api().post('/v1/agent/report', body, { authorization: `Bearer ${token}` }),
  };
  return { t, suzuna, cut, minimo, helper, agentId: issued.body.id as string };
}

const minimoStaff = {
  minimo_mail: {
    staff: [
      { id: 'rima-1', name: '🩶 suzuna🩶' },
      { id: 'rima-shop', name: '500%可愛い💘 fein.テスト店' },
      // a catch phrase after the name still finds the stylist
      { id: 'rima-yuri', name: '🩰yuri🩰 似合わせ/束感' },
    ],
  },
};

describe('媒体の自動枠止め (sync agent)', () => {
  it('hands block requests to the helper, takes its results, and reopens what it closed', async () => {
    const { t, suzuna, cut, minimo, helper } = await setup();
    const date = nextWeekday(WED);
    const customer = await createCustomer(t);
    // a booking that exists before the helper takes over is requested too
    const early = (
      await t.owner.post('/v1/appointments', {
        shopId: t.shopId,
        customerId: customer.id,
        staffId: suzuna.staffId,
        startAt: jst(date, '11:00'),
        menuIds: [cut.id],
      })
    ).body;
    await runJobs();
    expect((await helper.plan({ media: minimoStaff })).body.accounts).toEqual([]);

    const before = mockOutbox.length;
    expect(
      (
        await t.owner.patch(`/v1/integrations/${minimo.id}`, {
          config: { pushBlocks: true, mail: { agentManaged: true } },
        })
      ).status,
    ).toBe(200);
    await runJobs();
    const appt = (
      await t.owner.post('/v1/appointments', {
        shopId: t.shopId,
        customerId: customer.id,
        staffId: suzuna.staffId,
        startAt: jst(date, '15:00'),
        menuIds: [cut.id],
      })
    ).body;
    await runJobs();
    // no request mails: the helper does it
    expect(mockOutbox.slice(before).filter((m) => m.subject.includes('minimo'))).toHaveLength(0);

    let plan = (await helper.plan({ media: minimoStaff })).body;
    expect(plan.accounts).toHaveLength(1);
    const acc = plan.accounts[0];
    expect(acc.provider).toBe('minimo_mail');
    expect(acc.unmatchedStaff).toEqual(['500%可愛い💘 fein.テスト店']);
    expect(
      acc.tasks.map((x: { start: string; mediumStaffId: string; state: string }) => [
        x.start,
        x.mediumStaffId,
        x.state,
      ]),
    ).toEqual([
      [jst(date, '11:00'), 'rima-1', 'action_required'],
      [jst(date, '15:00'), 'rima-1', 'action_required'],
    ]);
    expect(acc.busy.map((b: { start: string }) => b.start).sort()).toEqual([
      jst(date, '11:00'),
      jst(date, '15:00'),
    ]);

    const results = acc.tasks.map(
      (x: { id: string; state: string; start: string; end: string }) => ({
        blockId: x.id,
        state: x.state,
        start: x.start,
        end: x.end,
        ok: true,
        record: { date, staff: 'rima-1', cells: [x.start] },
      }),
    );
    const rep = await helper.report({
      agentVersion: 'test',
      status: { minimo_mail: { ok: true } },
      results,
    });
    expect(rep.status).toBe(200);
    expect(rep.body).toEqual({ done: 2, failed: 0, stale: 0 });
    expect((await t.owner.get('/v1/integrations/manual-blocks')).body).toHaveLength(0);
    const agents = (await t.owner.get('/v1/integrations/agents')).body.data;
    expect(agents[0].last_seen_at).toBeTruthy();
    expect(agents[0].last_report.status.minimo_mail.ok).toBe(true);

    // cancel → reopen request, carrying what was closed
    await t.owner.post(`/v1/appointments/${appt.id}/cancel`, { reason: 'テスト' });
    await runJobs();
    plan = (await helper.plan({ media: minimoStaff })).body;
    expect(plan.accounts[0].tasks).toEqual([
      expect.objectContaining({
        state: 'remove_required',
        record: { date, staff: 'rima-1', cells: [jst(date, '15:00')] },
      }),
    ]);
    // the other booking that day still needs its slot
    expect(plan.accounts[0].busy.map((b: { appointmentId: string }) => b.appointmentId)).toEqual([
      early.id,
    ]);
    const task = plan.accounts[0].tasks[0];
    await helper.report({
      status: { minimo_mail: { ok: true } },
      results: [
        { blockId: task.id, state: task.state, start: task.start, end: task.end, ok: true },
      ],
    });
    const block = await asSystem(t.organizationId, (ctx) =>
      ctx.trx
        .selectFrom('external_slot_blocks')
        .select(['state', 'external_block_id'])
        .where('id', '=', task.id)
        .executeTakeFirstOrThrow(),
    );
    expect(block).toEqual({ state: 'removed', external_block_id: null });
  });

  it('keeps what was closed when the booking moved meanwhile, and records failures', async () => {
    const { t, suzuna, cut, minimo, helper } = await setup();
    await t.owner.patch(`/v1/integrations/${minimo.id}`, {
      config: { pushBlocks: true, mail: { agentManaged: true } },
    });
    const date = nextWeekday(WED);
    const customer = await createCustomer(t);
    const appt = (
      await t.owner.post('/v1/appointments', {
        shopId: t.shopId,
        customerId: customer.id,
        staffId: suzuna.staffId,
        startAt: jst(date, '15:00'),
        menuIds: [cut.id],
      })
    ).body;
    await runJobs();
    const [task] = (await helper.plan({ media: minimoStaff })).body.accounts[0].tasks;
    // moved while the helper was working
    await t.owner.patch(`/v1/appointments/${appt.id}`, {
      version: appt.version,
      startAt: jst(date, '17:00'),
    });
    await runJobs();
    const rep = await helper.report({
      status: { minimo_mail: { ok: true } },
      results: [
        {
          blockId: task.id,
          state: task.state,
          start: task.start,
          end: task.end,
          ok: true,
          record: { cells: ['15:00'] },
        },
      ],
    });
    expect(rep.body).toEqual({ done: 0, failed: 0, stale: 1 });
    const [next] = (await helper.plan({ media: minimoStaff })).body.accounts[0].tasks;
    expect(next).toMatchObject({
      state: 'action_required',
      start: jst(date, '17:00'),
      record: { cells: ['15:00'] },
    });

    await helper.report({
      status: { minimo_mail: { ok: true } },
      results: [
        {
          blockId: next.id,
          state: next.state,
          start: next.start,
          end: next.end,
          ok: false,
          error: 'minimo の保存に失敗しました',
        },
      ],
    });
    const open = (await t.owner.get('/v1/integrations/manual-blocks')).body;
    expect(open[0].message).toBe('自動枠止め: minimo の保存に失敗しました');
  });

  it('refuses unknown or revoked tokens', async () => {
    const { t, helper, agentId } = await setup();
    expect(
      (
        await api().post(
          '/v1/agent/plan',
          { media: {} },
          { authorization: 'Bearer sa_notarealtokennotarealtoken' },
        )
      ).status,
    ).toBe(401);
    expect((await api().post('/v1/agent/plan', { media: {} })).status).toBe(401);
    expect((await t.owner.delete(`/v1/integrations/agents/${agentId}`)).status).toBe(204);
    expect((await helper.plan({ media: {} })).status).toBe(401);
  });

  it('mails the shop once when the helper stops or a medium is logged out, and again after it recovered', async () => {
    const { t, minimo, helper, agentId } = await setup();
    await t.owner.patch(`/v1/integrations/${minimo.id}`, {
      config: { pushBlocks: true, mail: { agentManaged: true } },
    });
    const mine = () =>
      mockOutbox.filter((m) => m.to === 'front@salon.example' && m.subject.includes('自動枠止め'));
    const base = mine().length;
    // never reported
    await runAgentWatchdog(new Date(), [agentId]);
    await runAgentWatchdog(new Date(), [agentId]);
    expect(mine().length - base).toBe(1);
    expect(mine().at(-1)!.text).toContain('まだ一度も');

    await helper.report({ status: { minimo_mail: { ok: true } }, results: [] });
    await runAgentWatchdog(new Date(), [agentId]);
    const cleared = await asSystem(t.organizationId, (ctx) =>
      ctx.trx
        .selectFrom('sync_agents')
        .select('alerted_at')
        .where('id', '=', agentId)
        .executeTakeFirstOrThrow(),
    );
    expect(cleared.alerted_at).toBeNull();

    await helper.report({
      status: { minimo_mail: { ok: false, message: 'ログインが切れています' } },
      results: [],
    });
    await runAgentWatchdog(new Date(), [agentId]);
    expect(mine().length - base).toBe(2);
    expect(mine().at(-1)!.text).toContain('minimo');
  });

  it('does not ask SALON BOARD to block bookings copied from the previous system (already there)', async () => {
    const { t, suzuna, cut, helper } = await setup();
    const hp = (
      await t.owner.post('/v1/integrations', {
        provider: 'hotpepper_mail',
        shopId: t.shopId,
        displayName: 'ホットペッパー',
        config: { pushBlocks: true, staffMap: { 'suzu na': suzuna.staffId } },
      })
    ).body;
    const date = nextWeekday(WED);
    const customer = await createCustomer(t);
    const copied = (
      await t.owner.post('/v1/appointments', {
        shopId: t.shopId,
        customerId: customer.id,
        staffId: suzuna.staffId,
        startAt: jst(date, '11:00'),
        menuIds: [cut.id],
      })
    ).body;
    const fresh = (
      await t.owner.post('/v1/appointments', {
        shopId: t.shopId,
        customerId: customer.id,
        staffId: suzuna.staffId,
        startAt: jst(date, '15:00'),
        menuIds: [cut.id],
      })
    ).body;
    await asSystem(t.organizationId, (ctx) =>
      ctx.trx
        .updateTable('appointments')
        .set({ source_detail: JSON.stringify({ migrated: true }) })
        .where('id', '=', copied.id)
        .execute(),
    );
    await runJobs();
    // the manual requests made so far are dropped; switching to the helper asks again
    await asSystem(t.organizationId, (ctx) =>
      ctx.trx
        .deleteFrom('external_slot_blocks')
        .where('integration_account_id', '=', hp.id)
        .execute(),
    );
    await t.owner.patch(`/v1/integrations/${hp.id}`, { config: { mail: { agentManaged: true } } });
    await runJobs();
    const plan = (
      await helper.plan({ media: { hotpepper_mail: { staff: [{ id: 'W1', name: 'suzu na' }] } } })
    ).body;
    const acc = plan.accounts.find((a: { provider: string }) => a.provider === 'hotpepper_mail');
    expect(
      acc.tasks.map((x: { start: string; mediumStaffId: string }) => [x.start, x.mediumStaffId]),
    ).toEqual([[jst(date, '15:00'), 'W1']]);
    void fresh;
  });
});
