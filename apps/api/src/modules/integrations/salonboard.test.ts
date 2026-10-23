import { readFile } from 'node:fs/promises';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
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

const WED = 3;

async function setup(opts: { auto?: boolean } = {}) {
  const t = await createTenant();
  await t.owner.patch(`/v1/staff/${t.ownerStaffId}`, { isBookable: false });
  const aika = await createStaffUser(t, 'stylist', { displayName: '佐藤 あいか' });
  const rina = await createStaffUser(t, 'stylist', { displayName: 'rina' });
  const cut = await createMenu(t, { name: 'カット', durationMin: 60 });
  const hp = (
    await t.owner.post('/v1/integrations', {
      provider: 'hotpepper_mail',
      shopId: t.shopId,
      displayName: 'ホットペッパー',
      config: {
        pushBlocks: true,
        staffMap: { 'ri na': rina.staffId },
        mail: { agentManaged: opts.auto ?? true },
      },
    })
  ).body;
  const issued = await t.owner.post('/v1/integrations/agents', { shopId: t.shopId, name: 'Mac' });
  const token = issued.body.token as string;
  const helper = {
    plan: (body: unknown) =>
      api().post('/v1/agent/plan', body, { authorization: `Bearer ${token}` }),
    report: (body: unknown) =>
      api().post('/v1/agent/report', body, { authorization: `Bearer ${token}` }),
  };
  const book = async (staffId: string, time: string) => {
    const customer = await createCustomer(t);
    const res = await t.owner.post('/v1/appointments', {
      shopId: t.shopId,
      customerId: customer.id,
      staffId,
      startAt: jst(nextWeekday(WED), time),
      menuIds: [cut.id],
    });
    expect(res.status).toBe(201);
    await runJobs();
    return res.body as { id: string; version: number };
  };
  return { t, aika, rina, cut, hp, helper, book };
}

const hpConfig = async (t: Awaited<ReturnType<typeof createTenant>>, id: string) =>
  (await t.owner.get(`/v1/integrations/${id}`)).body.config;

describe('サロンボード スタッフ名 / スタッフID (スタッフ編集)', () => {
  it('stores both on the stylist and keeps the SALON BOARD staff map in step', async () => {
    const { t, aika, rina, hp } = await setup();
    const res = await t.owner.patch(`/v1/staff/${aika.staffId}`, {
      salonboardName: 'ai ka',
      salonboardStaffId: 'W000123456',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      salonboard_name: 'ai ka',
      salonboard_staff_id: 'W000123456',
    });
    expect((await t.owner.get(`/v1/staff/${aika.staffId}`)).body.salonboard_staff_id).toBe(
      'W000123456',
    );
    const dir = (await t.owner.get(`/v1/shops/${t.shopId}/staff-directory`)).body as {
      id: string;
      salonboard_name: string | null;
    }[];
    expect(dir.find((s) => s.id === aika.staffId)!.salonboard_name).toBe('ai ka');
    expect((await hpConfig(t, hp.id)).staffMap).toEqual({
      'ri na': rina.staffId,
      'ai ka': aika.staffId,
    });

    // renamed: the old name no longer points to her
    await t.owner.patch(`/v1/staff/${aika.staffId}`, { salonboardName: 'aika' });
    expect((await hpConfig(t, hp.id)).staffMap).toEqual({
      'ri na': rina.staffId,
      aika: aika.staffId,
    });
    // cleared
    await t.owner.patch(`/v1/staff/${aika.staffId}`, { salonboardName: '', salonboardStaffId: '' });
    const cleared = (await t.owner.get(`/v1/staff/${aika.staffId}`)).body;
    expect([cleared.salonboard_name, cleared.salonboard_staff_id]).toEqual([null, null]);
    expect((await hpConfig(t, hp.id)).staffMap).toEqual({ 'ri na': rina.staffId });

    // other fields leave the map alone
    await t.owner.patch(`/v1/staff/${rina.staffId}`, { title: 'スタイリスト' });
    expect((await hpConfig(t, hp.id)).staffMap).toEqual({ 'ri na': rina.staffId });
  });

  it('migration 0184 gives stylists already on the SALON BOARD staff map that name', async () => {
    const { t, aika, rina, hp } = await setup();
    await t.owner.patch(`/v1/integrations/${hp.id}`, {
      config: {
        staffMap: { 'ri na': rina.staffId, '🌙ri na🌙': rina.staffId, 'ai ka': aika.staffId },
      },
    });
    await asSystem(t.organizationId, (ctx) =>
      ctx.trx
        .updateTable('staffs')
        .set({ salonboard_name: 'aika' })
        .where('id', '=', aika.staffId)
        .execute(),
    );
    const file = await readFile(
      new URL('../../db/migrations/0184_staff_salonboard.sql', import.meta.url),
      'utf8',
    );
    const backfill = file.slice(file.indexOf('UPDATE staffs'));
    await asSystem(t.organizationId, (ctx) => sql.raw(backfill).execute(ctx.trx));
    expect((await t.owner.get(`/v1/staff/${rina.staffId}`)).body.salonboard_name).toBe('ri na');
    // a name set already is kept
    expect((await t.owner.get(`/v1/staff/${aika.staffId}`)).body.salonboard_name).toBe('aika');
  });

  it('refuses a name or id another stylist of the shop uses, and ids that are not letters/digits', async () => {
    const { t, aika, rina } = await setup();
    await t.owner.patch(`/v1/staff/${rina.staffId}`, {
      salonboardName: 'ri na',
      salonboardStaffId: 'W1',
    });
    const dupName = await t.owner.patch(`/v1/staff/${aika.staffId}`, { salonboardName: 'ri na' });
    expect(dupName.status).toBe(400);
    const dupId = await t.owner.patch(`/v1/staff/${aika.staffId}`, { salonboardStaffId: 'W1' });
    expect(dupId.status).toBe(400);
    const bad = await t.owner.patch(`/v1/staff/${aika.staffId}`, {
      salonboardStaffId: 'staffId=W1',
    });
    expect(bad.status).toBe(400);
    // a stylist cannot set it on themself
    expect(
      (await aika.api.patch(`/v1/staff/${aika.staffId}`, { salonboardName: 'ai ka' })).status,
    ).toBe(403);
  });

  it('the 自動枠止め helper matches SALON BOARD stylists by スタッフID before names', async () => {
    const { t, aika, rina, book, helper } = await setup();
    await t.owner.patch(`/v1/staff/${aika.staffId}`, { salonboardStaffId: 'W2' });
    await book(aika.staffId, '11:00');
    await book(rina.staffId, '15:00');
    const plan = (
      await helper.plan({
        media: {
          hotpepper_mail: {
            staff: [
              // her Salon OS name on another SALON BOARD stylist: the id wins
              { id: 'W1', name: '佐藤 あいか' },
              { id: 'W2', name: 'ai ka🌙' },
              { id: 'W3', name: 'ri na' },
            ],
          },
        },
      })
    ).body;
    const acc = plan.accounts[0];
    expect(
      acc.tasks.map((x: { staffId: string; mediumStaffId: string }) => [
        x.staffId,
        x.mediumStaffId,
      ]),
    ).toEqual([
      [aika.staffId, 'W2'],
      [rina.staffId, 'W3'],
    ]);
    expect(acc.unmatchedStaff).toEqual([]);
  });

  it('booking mails find a stylist by her サロンボード スタッフ名 at a shop added later', async () => {
    const { t, aika, hp } = await setup();
    await t.owner.patch(`/v1/staff/${aika.staffId}`, { salonboardName: 'ai ka' });
    // the map lost the entry (e.g. edited by hand on 外部連携): the stylist's own name still matches
    await t.owner.patch(`/v1/integrations/${hp.id}`, { config: { staffMap: {} } });
    const res = await t.owner.post(`/v1/integrations/${hp.id}/parse-test`, {
      subject: '【HOT PEPPER Beauty】予約連絡（BE12345678）',
      text: 'スタッフ：ai ka',
    });
    expect(res.status).toBe(200);
    expect(res.body.mapping?.staff ?? res.body.staff).toMatchObject({ staffId: aika.staffId });
  });
});

describe('予約詳細: サロンボードに連携', () => {
  it('shows the SALON BOARD state on the booking and asks again when nothing is on record', async () => {
    const { t, rina, book, helper } = await setup();
    const appt = await book(rina.staffId, '15:00');
    let sb = (await t.owner.get(`/v1/appointments/${appt.id}`)).body.media_sync.salonboard;
    expect(sb).toMatchObject({ enabled: true, auto: true, origin: null, state: 'waiting' });

    // the helper found the time held already: settled without a 予定
    const staff = { hotpepper_mail: { staff: [{ id: 'W3', name: 'ri na' }] } };
    const [task] = (await helper.plan({ media: staff })).body.accounts[0].tasks;
    await helper.report({
      status: { hotpepper_mail: { ok: true } },
      results: [
        {
          blockId: task.id,
          state: task.state,
          start: task.start,
          end: task.end,
          ok: true,
          record: { skipped: 'サロンボードに同じ時間の予定があります' },
        },
      ],
    });
    const detail = (await t.owner.get(`/v1/appointments/${appt.id}`)).body;
    sb = detail.media_sync.salonboard;
    expect(sb).toMatchObject({
      state: 'synced',
      message: 'サロンボードに同じ時間の予定があります',
    });
    expect(sb.synced_at).toBeTruthy();
    expect(detail.media_sync.blocks[0]).toMatchObject({
      state: 'pushed',
      skipped: 'サロンボードに同じ時間の予定があります',
    });
    expect(detail.media_sync.blocks[0].done_at).toBeTruthy();

    // 再同期: nothing on record → the helper looks again
    const res = await t.owner.post(`/v1/appointments/${appt.id}/sync-salonboard`);
    expect(res.status).toBe(200);
    expect(res.body.salonboard).toMatchObject({ state: 'waiting' });
    await runJobs();
    const again = (await helper.plan({ media: staff })).body.accounts[0].tasks;
    expect(again).toHaveLength(1);

    // the helper adds the 予定 this time
    const record = {
      staffId: 'W3',
      date: '20261111',
      startTime: '1500',
      endTime: '1600',
      execTime: 60,
    };
    await helper.report({
      status: { hotpepper_mail: { ok: true } },
      results: [
        {
          blockId: again[0].id,
          state: again[0].state,
          start: again[0].start,
          end: again[0].end,
          ok: true,
          record,
        },
      ],
    });
    // with a 予定 on record the button changes nothing (idempotent)
    const twice = await t.owner.post(`/v1/appointments/${appt.id}/sync-salonboard`);
    expect(twice.body.salonboard).toMatchObject({ state: 'synced', message: null });
    await runJobs();
    expect((await helper.plan({ media: staff })).body.accounts[0].tasks).toHaveLength(0);
  });

  it('reports a helper failure as an error, and 再試行 clears it', async () => {
    const { t, rina, book, helper } = await setup();
    const appt = await book(rina.staffId, '15:00');
    const staff = { hotpepper_mail: { staff: [{ id: 'W3', name: 'ri na' }] } };
    const [task] = (await helper.plan({ media: staff })).body.accounts[0].tasks;
    await helper.report({
      status: { hotpepper_mail: { ok: true } },
      results: [
        {
          blockId: task.id,
          state: task.state,
          start: task.start,
          end: task.end,
          ok: false,
          error: 'サロンボードに予定を追加できませんでした（500）',
        },
      ],
    });
    let sb = (await t.owner.get(`/v1/appointments/${appt.id}`)).body.media_sync.salonboard;
    expect(sb).toMatchObject({
      state: 'error',
      message: '自動枠止め: サロンボードに予定を追加できませんでした（500）',
    });
    const res = await t.owner.post(`/v1/appointments/${appt.id}/sync-salonboard`);
    expect(res.body.salonboard).toMatchObject({ state: 'waiting' });
    sb = (await t.owner.get(`/v1/appointments/${appt.id}`)).body.media_sync.salonboard;
    expect(sb.state).toBe('waiting');
  });

  it('refuses bookings SALON BOARD holds by itself, cancelled ones, and shops without the connector', async () => {
    const { t, rina, hp, book } = await setup();
    const migrated = await book(rina.staffId, '11:00');
    await asSystem(t.organizationId, (ctx) =>
      ctx.trx
        .updateTable('appointments')
        .set({ source_detail: JSON.stringify({ migrated: true }) })
        .where('id', '=', migrated.id)
        .execute(),
    );
    const m = await t.owner.post(`/v1/appointments/${migrated.id}/sync-salonboard`);
    expect(m.status).toBe(422);
    expect(m.body.error.code).toBe('SALONBOARD_MIGRATED');

    const cancelled = await book(rina.staffId, '17:00');
    await t.owner.post(`/v1/appointments/${cancelled.id}/cancel`, { reason: 'テスト' });
    expect(
      (await t.owner.post(`/v1/appointments/${cancelled.id}/sync-salonboard`)).body.error.code,
    ).toBe('APPOINTMENT_NOT_ACTIVE');

    const other = await book(rina.staffId, '13:00');
    await t.owner.patch(`/v1/integrations/${hp.id}`, { config: { pushBlocks: false } });
    expect(
      (await t.owner.post(`/v1/appointments/${other.id}/sync-salonboard`)).body.error.code,
    ).toBe('SALONBOARD_DISABLED');
    await t.owner.delete(`/v1/integrations/${hp.id}`);
    const none = await t.owner.post(`/v1/appointments/${other.id}/sync-salonboard`);
    expect(none.body.error.code).toBe('SALONBOARD_NOT_CONNECTED');
    // without a SALON BOARD connector the booking carries no SALON BOARD state
    expect((await t.owner.get(`/v1/appointments/${other.id}`)).body.media_sync.salonboard).toBe(
      undefined,
    );
  });

  it('needs appointment.write and the shop', async () => {
    const { t, rina, book } = await setup();
    const appt = await book(rina.staffId, '15:00');
    const assistant = await createStaffUser(t, 'assistant');
    expect((await assistant.api.post(`/v1/appointments/${appt.id}/sync-salonboard`)).status).toBe(
      403,
    );
    const other = await createTenant('別サロン');
    expect((await other.owner.post(`/v1/appointments/${appt.id}/sync-salonboard`)).status).toBe(
      404,
    );
  });
});

describe('HPBメール受信アドレス', () => {
  it('is kept on the SALON BOARD connector', async () => {
    const { t, hp } = await setup();
    const res = await t.owner.patch(`/v1/integrations/${hp.id}`, {
      config: { mail: { forwardAddress: 'shop.yoyaku+tag@example.com' } },
    });
    expect(res.status).toBe(200);
    expect(res.body.config.mail).toMatchObject({
      forwardAddress: 'shop.yoyaku+tag@example.com',
      agentManaged: true,
    });
    expect(res.body.config.mail.inboundToken).toBeTruthy();
    expect(
      (
        await t.owner.patch(`/v1/integrations/${hp.id}`, {
          config: { mail: { forwardAddress: 'x'.repeat(201) } },
        })
      ).status,
    ).toBe(400);
  });
});
