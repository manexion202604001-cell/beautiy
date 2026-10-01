import { describe, expect, it } from 'vitest';
import { mockOutbox } from '../../../lib/mailer.js';
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
  type Tenant,
} from '../../../test/helpers.js';

const WED = 3;

async function setup() {
  const t = await createTenant();
  await t.owner.patch(`/v1/staff/${t.ownerStaffId}`, { isBookable: false });
  const misaki = await createStaffUser(t, 'stylist', { displayName: '佐藤 美咲' });
  const cut = await createMenu(t, { name: 'カット', durationMin: 60 });
  const color = await createMenu(t, { name: 'カット+カラー', durationMin: 120 });
  await t.owner.patch(`/v1/shops/${t.shopId}`, { email: 'front@salon.example' });
  const hp = await t.owner.post('/v1/integrations', {
    provider: 'hotpepper_mail',
    shopId: t.shopId,
    displayName: 'ホットペッパー',
    config: { pushBlocks: true },
  });
  expect(hp.status).toBe(201);
  return { t, misaki, cut, color, hp: hp.body };
}

function bookingMail(
  no: string,
  date: string,
  time: string,
  extra: Partial<Record<'staff' | 'menu' | 'subject' | 'name' | 'phone', string>> = {},
) {
  return {
    subject: extra.subject ?? '【SALON BOARD】予約連絡',
    text: [
      '下記の内容で予約が入りました。',
      `予約番号：${no}`,
      `来店日時：${date.replace(/-/g, '/')} ${time}`,
      `お客様名：${extra.name ?? '山田 花子'} 様`,
      'フリガナ：ヤマダ ハナコ',
      `電話番号：${extra.phone ?? '090-1111-2222'}`,
      `指名スタッフ：${extra.staff ?? '佐藤'}`,
      'メニュー：',
      extra.menu ?? '【全員】カット＋カラー ¥12,000',
    ].join('\n'),
    messageId: `<${no}-${Math.random()}@salonboard.example>`,
    date: new Date().toISOString(),
  };
}

const post = (token: string, body: unknown, headers: Record<string, string> = {}) =>
  api().post(`/v1/webhooks/inbound_email/${token}`, body, headers);
const tokenOf = (hp: { inboundEmail: { webhookUrl: string } }) =>
  hp.inboundEmail.webhookUrl.split('/').pop()!;

async function externalAppointments(t: Tenant) {
  return asSystem(t.organizationId, (ctx) =>
    ctx.trx
      .selectFrom('appointments')
      .select(['id', 'start_at', 'status', 'staff_id', 'source', 'customer_id'])
      .where('source', '=', 'external')
      .orderBy('created_at')
      .execute(),
  );
}

describe('Hot Pepper / LiME booking-notification mail sync', () => {
  it('creates, changes and cancels appointments from forwarded mails (names auto-matched)', async () => {
    const { t, misaki, hp } = await setup();
    expect(hp.pushMode).toBe('manual');
    const token = tokenOf(hp);
    const date = nextWeekday(WED);

    const res = await post(token, bookingMail('BE00000001', date, '14:00'));
    expect(res.status).toBe(200);
    await runJobs();
    let appts = await externalAppointments(t);
    expect(appts).toHaveLength(1);
    expect(appts[0]!.start_at.toISOString()).toBe(jst(date, '14:00'));
    expect(appts[0]!.staff_id).toBe(misaki.staffId);
    const appt = (await t.owner.get(`/v1/appointments/${appts[0]!.id}`)).body;
    expect(appt.services.map((s: { name: string }) => s.name)).toEqual(['カット+カラー']);
    expect(appt.customer_name).toBe('山田 花子');

    // the same mail delivered twice (same Message-ID) is acknowledged but not re-applied
    const dupMail = bookingMail('BE00000001', date, '14:00');
    await post(token, dupMail);
    const again = await post(token, dupMail);
    expect(again.body.duplicates).toBe(1);

    // change mail → rescheduled
    await post(
      token,
      bookingMail('BE00000001', date, '16:00', { subject: '【SALON BOARD】予約変更連絡' }),
    );
    await runJobs();
    appts = await externalAppointments(t);
    expect(appts).toHaveLength(1);
    expect(appts[0]!.start_at.toISOString()).toBe(jst(date, '16:00'));

    // cancellation mail with only the booking number → cancelled
    await post(token, {
      subject: '【SALON BOARD】予約キャンセル連絡',
      text: '予約番号：BE00000001\nお客様名：山田 花子 様',
      messageId: '<cancel-1@x>',
    });
    await runJobs();
    appts = await externalAppointments(t);
    expect(appts[0]!.status).toBe('cancelled');
  });

  it('accepts Mailgun/SendGrid form posts, rejects unknown tokens, ignores non-booking mails', async () => {
    const { t, hp } = await setup();
    const token = tokenOf(hp);
    const date = nextWeekday(WED);
    const m = bookingMail('BE00000002', date, '11:00', { menu: 'カット' });
    const form = new URLSearchParams({
      subject: `Fwd: ${m.subject}`,
      'body-plain': m.text,
      'Message-Id': m.messageId,
      sender: 'notice@salonboard.com',
    }).toString();
    const res = await post(token, form, { 'content-type': 'application/x-www-form-urlencoded' });
    expect(res.status).toBe(200);
    expect((await post('x'.repeat(24), m)).status).toBe(401);
    await post(token, {
      subject: 'キャンペーンのお知らせ',
      text: '今月のおすすめ',
      messageId: '<news@x>',
    });
    await runJobs();
    const appts = await externalAppointments(t);
    expect(appts).toHaveLength(1);
    const events = await asSystem(t.organizationId, (ctx) =>
      ctx.trx
        .selectFrom('webhook_events')
        .select(['status'])
        .where('provider', '=', 'inbound_email')
        .where('organization_id', '=', t.organizationId)
        .execute(),
    );
    expect(events.map((e) => e.status).sort()).toEqual(['ignored', 'processed']);
  });

  it('routes unknown menus and overlaps to the conflict queue; default menu fallback', async () => {
    const { t, misaki, cut, hp } = await setup();
    const token = tokenOf(hp);
    const date = nextWeekday(WED);
    await post(token, bookingMail('BE00000003', date, '10:00', { menu: '縮毛矯正スペシャル' }));
    await runJobs();
    let conflicts = (await t.owner.get('/v1/sync-conflicts', { state: 'open' })).body.items;
    expect(conflicts.map((c: { conflict_type: string }) => c.conflict_type)).toContain(
      'unknown_menu',
    );

    await t.owner.patch(`/v1/integrations/${hp.id}`, {
      config: { mail: { defaultMenuId: cut.id } },
    });
    await post(token, bookingMail('BE00000004', date, '12:00', { menu: '縮毛矯正スペシャル' }));
    // overlap: an internal booking already holds 17:00
    await t.owner.post('/v1/appointments', {
      shopId: t.shopId,
      staffId: misaki.staffId,
      startAt: jst(date, '17:00'),
      menuIds: [cut.id],
    });
    await post(token, bookingMail('BE00000005', date, '17:00', { menu: 'カット' }));
    await runJobs();
    const appts = await externalAppointments(t);
    expect(appts.map((a) => a.start_at.toISOString())).toEqual([jst(date, '12:00')]);
    conflicts = (await t.owner.get('/v1/sync-conflicts', { state: 'open' })).body.items;
    expect(conflicts.map((c: { conflict_type: string }) => c.conflict_type)).toContain('overlap');
    // the token survived the partial config update
    const fresh = (await t.owner.get(`/v1/integrations/${hp.id}`)).body;
    expect(tokenOf(fresh)).toBe(token);
  });

  it('turns bookings from other channels into manual block requests (notify → done → reopen)', async () => {
    const { t, misaki, cut } = await setup();
    const lime = (
      await t.owner.post('/v1/integrations', {
        provider: 'lime_mail',
        shopId: t.shopId,
        displayName: 'LiME',
        config: { pushBlocks: true },
      })
    ).body;
    const date = nextWeekday(WED);
    const before = mockOutbox.length;
    const customer = await createCustomer(t);
    const appt = (
      await t.owner.post('/v1/appointments', {
        shopId: t.shopId,
        customerId: customer.id,
        staffId: misaki.staffId,
        startAt: jst(date, '15:00'),
        menuIds: [cut.id],
      })
    ).body;
    await runJobs();
    let tasks = (await t.owner.get('/v1/integrations/manual-blocks')).body;
    expect(tasks.map((x: { provider: string }) => x.provider).sort()).toEqual([
      'hotpepper_mail',
      'lime_mail',
    ]);
    expect(tasks.every((x: { state: string }) => x.state === 'action_required')).toBe(true);
    const sent = mockOutbox.slice(before).filter((m) => m.to === 'front@salon.example');
    expect(sent.length).toBe(2);
    expect(sent[0]!.subject).toContain('枠を止めてください');

    const hpTask = tasks.find((x: { provider: string }) => x.provider === 'hotpepper_mail');
    expect(
      (await t.owner.post(`/v1/integrations/manual-blocks/${hpTask.id}/done`)).body.state,
    ).toBe('pushed');
    const status = (await t.owner.get('/v1/integrations/status')).body.shops[0].accounts;
    expect(
      status.find((a: { provider: string }) => a.provider === 'lime_mail').manualActionRequired,
    ).toBe(1);

    // cancel: the blocked HP slot must be reopened, the never-done LiME task disappears
    await t.owner.post(`/v1/appointments/${appt.id}/cancel`, { reason: 'テスト' });
    await runJobs();
    tasks = (await t.owner.get('/v1/integrations/manual-blocks')).body;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ provider: 'hotpepper_mail', state: 'remove_required' });
    expect(
      (await t.owner.post(`/v1/integrations/manual-blocks/${tasks[0].id}/done`)).body.state,
    ).toBe('removed');
    void lime;
  });

  it('never asks to block a booking on the medium it came from, but does on the other medium', async () => {
    const { t, hp } = await setup();
    await t.owner.post('/v1/integrations', {
      provider: 'lime_mail',
      shopId: t.shopId,
      displayName: 'LiME',
      config: { pushBlocks: true },
    });
    await post(
      tokenOf(hp),
      bookingMail('BE00000006', nextWeekday(WED), '13:00', { menu: 'カット' }),
    );
    await runJobs();
    const tasks = (await t.owner.get('/v1/integrations/manual-blocks')).body;
    expect(tasks.map((x: { provider: string }) => x.provider)).toEqual(['lime_mail']);
  });

  it('previews parsing and mapping (parse test) and imports existing bookings from CSV', async () => {
    const { t, hp } = await setup();
    const date = nextWeekday(WED);
    const m = bookingMail('BE00000007', date, '10:30', { staff: '田中', menu: 'カット' });
    const preview = await t.owner.post(`/v1/integrations/${hp.id}/parse-test`, {
      subject: m.subject,
      text: m.text,
    });
    expect(preview.body).toMatchObject({
      kind: 'booked',
      externalId: 'BE00000007',
      ready: false,
      menus: [{ name: 'カット', via: 'auto' }],
    });
    expect(preview.body.warnings.join()).toContain('田中');

    // automatic menu matching never guesses between several candidates
    await createMenu(t, { name: 'リタッチカラー', durationMin: 60 });
    const m2 = bookingMail('BE00000008', date, '10:30', { menu: '【全員】カット+カラー ¥12,000\nカラー\nリタッチ' });
    const ambiguous = await t.owner.post(`/v1/integrations/${hp.id}/parse-test`, { subject: m2.subject, text: m2.text });
    expect(ambiguous.body.menus).toEqual([
      expect.objectContaining({ name: 'カット+カラー', menuName: 'カット+カラー', via: 'auto' }),
      expect.objectContaining({ name: 'カラー', menuId: null }),
      expect.objectContaining({ name: 'リタッチ', menuName: 'リタッチカラー', via: 'auto' }),
    ]);

    const csv = [
      '予約番号,来店日,開始時刻,お客様名,電話番号,メニュー,担当,状態',
      `L-1,${date},11:00,鈴木 一郎,080-3333-4444,カット,佐藤 美咲,予約`,
      `L-2,${date},13:00,高橋 次郎,,カット,,キャンセル`,
      `L-3,不明,13:00,X,,カット,,予約`,
    ].join('\n');
    const dry = await t.owner.post(`/v1/integrations/${hp.id}/import-csv`, { csv, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.summary).toEqual({ preview: 2, error: 1 });
    expect(await externalAppointments(t)).toHaveLength(0);
    const real = await t.owner.post(`/v1/integrations/${hp.id}/import-csv`, { csv, dryRun: false });
    expect(real.body.summary).toMatchObject({ created: 1, error: 1 });
    const appts = await externalAppointments(t);
    expect(appts).toHaveLength(1);
    expect(appts[0]!.start_at.toISOString()).toBe(jst(date, '11:00'));
  });
});
