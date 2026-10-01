import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatJst } from '../../lib/time.js';
import {
  api,
  createLineChannel,
  createMenu,
  createStaffUser,
  createTenant,
  jst,
  lineFollower,
  makeJobsDue,
  messagesOf,
  nextWeekday,
  runJobs,
  setClock,
  updateCustomer,
} from '../../test/helpers.js';
import { lineMock } from './providers/line.js';

beforeEach(() => lineMock.reset());
afterEach(() => setClock(null));

const WED = 3;

function prevDay(date: string) {
  return DateTime.fromISO(date).minus({ days: 1 }).toISODate()!;
}

async function setup() {
  const t = await createTenant();
  const ch = await createLineChannel(t);
  const stylist = await createStaffUser(t, 'stylist', { displayName: '担当者' });
  const menu = await createMenu(t, { name: 'カラー' });
  const follower = await lineFollower(t, ch);
  await updateCustomer(t, follower.customerId, { last_name: '通知', first_name: '花子' });
  return { t, ch, stylist, menu, ...follower };
}

function byTemplate(msgs: Awaited<ReturnType<typeof messagesOf>>, key: string) {
  return msgs.filter((m) => (m.payload as { templateKey?: string }).templateKey === key);
}

describe('appointment notifications', () => {
  it('sends the confirmation and schedules day-before / same-day reminders', async () => {
    const { t, stylist, menu, customerId, userId } = await setup();
    const date = nextWeekday(WED);
    const res = await t.owner.post('/v1/appointments', { shopId: t.shopId, customerId, staffId: stylist.staffId, startAt: jst(date, '15:00'), menuIds: [menu.id] });
    expect(res.status).toBe(201);
    const id = res.body.id;
    await runJobs();

    const msgs = await messagesOf(t, customerId);
    const confirmed = byTemplate(msgs, 'booking_confirmed');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ status: 'sent', dedupe_key: `appt:${id}:confirmed`, appointment_id: id, category: 'transactional' });
    expect((lineMock.sentTo(userId)[0]!.messages[0] as { text: string }).text).toContain('ご予約が確定しました');

    const startIso = new Date(jst(date, '15:00')).toISOString();
    const dayBefore = byTemplate(msgs, 'reminder_day_before')[0]!;
    expect(dayBefore).toMatchObject({ status: 'queued', dedupe_key: `appt:${id}:reminder:day_before:${startIso}` });
    expect(dayBefore.scheduled_at?.toISOString()).toBe(new Date(jst(prevDay(date), '18:00')).toISOString());
    const sameDay = byTemplate(msgs, 'reminder_same_day')[0]!;
    expect(sameDay.scheduled_at?.toISOString()).toBe(new Date(jst(date, '12:00')).toISOString());
    expect(lineMock.sentTo(userId)).toHaveLength(1); // reminders not sent yet

    // a job woken up early does not send before the scheduled time
    await makeJobsDue(t);
    await runJobs();
    expect(lineMock.sentTo(userId)).toHaveLength(1);
    // when due, the reminders are delivered with appointment details
    setClock(new Date(sameDay.scheduled_at!.getTime() + 1000));
    await makeJobsDue(t);
    await runJobs();
    const texts = lineMock.sentTo(userId).map((s) => (s.messages[0] as { text: string }).text);
    expect(texts.some((x) => x.includes('明日のご予約のお知らせです') && x.includes('カラー'))).toBe(true);
    expect(texts.some((x) => x.includes('本日15:00からのご予約'))).toBe(true);

    // idempotent: re-emitting the same notification never queues duplicates (dedupe key)
    const { queueMessage } = await import('./api.js');
    const { asSystem } = await import('../../test/helpers.js');
    const dup = await asSystem(t.organizationId, (ctx) => queueMessage(ctx, { customerId, category: 'transactional', templateKey: 'booking_confirmed', dedupeKey: `appt:${id}:confirmed` }));
    expect(dup).toEqual({ messageId: null, skipped: 'duplicate' });
  });

  it('reschedule cancels old reminders, schedules new ones and sends booking_changed', async () => {
    const { t, stylist, menu, customerId, userId } = await setup();
    const date = nextWeekday(WED);
    const created = await t.owner.post('/v1/appointments', { shopId: t.shopId, customerId, staffId: stylist.staffId, startAt: jst(date, '15:00'), menuIds: [menu.id] });
    await runJobs();
    const moved = await t.owner.patch(`/v1/appointments/${created.body.id}`, { version: created.body.version, startAt: jst(date, '17:00') });
    expect(moved.status).toBe(200);
    await runJobs();
    const msgs = await messagesOf(t, customerId);
    const reminders = msgs.filter((m) => m.dedupe_key?.includes(':reminder:'));
    const oldStart = new Date(jst(date, '15:00')).toISOString();
    const newStart = new Date(jst(date, '17:00')).toISOString();
    expect(reminders.filter((m) => m.status === 'cancelled')).toHaveLength(2);
    expect(reminders.filter((m) => m.status === 'cancelled').every((m) => m.dedupe_key!.includes(oldStart) && m.dedupe_key!.includes('#cancelled:'))).toBe(true);
    const active = reminders.filter((m) => m.status === 'queued');
    expect(active.map((m) => m.dedupe_key).sort()).toEqual([`appt:${created.body.id}:reminder:day_before:${newStart}`, `appt:${created.body.id}:reminder:same_day:${newStart}`]);
    expect(active.find((m) => m.dedupe_key!.includes('same_day'))!.scheduled_at?.toISOString()).toBe(new Date(jst(date, '14:00')).toISOString());

    const changed = byTemplate(msgs, 'booking_changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.status).toBe('sent');
    const text = (lineMock.sentTo(userId).at(-1)!.messages[0] as { text: string }).text;
    expect(text).toContain('ご予約内容が変更されました');
    expect(text).toContain(formatJst(new Date(jst(date, '17:00')), 'M月d日(EEE) H:mm'));
    expect(text).toContain(`変更前の日時：${formatJst(new Date(jst(date, '15:00')), 'M月d日(EEE) H:mm')}`);

    // moving back to the original time works (cancelled keys were released)
    const back = await t.owner.patch(`/v1/appointments/${created.body.id}`, { version: moved.body.version, startAt: jst(date, '15:00') });
    expect(back.status).toBe(200);
    const msgs2 = await messagesOf(t, customerId);
    expect(msgs2.filter((m) => m.status === 'queued' && m.dedupe_key?.includes(`:reminder:day_before:${oldStart}`))).toHaveLength(1);
    expect(byTemplate(msgs2, 'booking_changed')).toHaveLength(2);
  });

  it('cancellation by staff cancels reminders and notifies; restore re-schedules', async () => {
    const { t, stylist, menu, customerId, userId } = await setup();
    const date = nextWeekday(WED);
    const created = await t.owner.post('/v1/appointments', { shopId: t.shopId, customerId, staffId: stylist.staffId, startAt: jst(date, '11:00'), menuIds: [menu.id] });
    const cancelled = await t.owner.post(`/v1/appointments/${created.body.id}/cancel`, { reason: '店舗都合' });
    expect(cancelled.status).toBe(200);
    await runJobs();
    const msgs = await messagesOf(t, customerId);
    // confirmation was still queued at cancel time → cancelled together with the reminders
    expect(msgs.filter((m) => m.status === 'cancelled').length).toBeGreaterThanOrEqual(2);
    expect(msgs.filter((m) => m.dedupe_key?.includes(':reminder:') && m.status === 'queued')).toHaveLength(0);
    const cancelMsg = byTemplate(msgs, 'booking_cancelled')[0]!;
    expect(cancelMsg.status).toBe('sent');
    const text = (lineMock.sentTo(userId).at(-1)!.messages[0] as { text: string }).text;
    expect(text).toContain('以下のご予約はキャンセルとなりました');
    expect(text).not.toContain('店舗都合'); // internal reason is not leaked

    const restored = await t.owner.post(`/v1/appointments/${created.body.id}/restore`);
    expect(restored.status).toBe(200);
    const msgs2 = await messagesOf(t, customerId);
    expect(msgs2.filter((m) => m.dedupe_key?.includes(':reminder:') && m.status === 'queued')).toHaveLength(2);
  });

  it('confirms the cancellation when the customer cancels online', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    const menu = await createMenu(t);
    const shop = (await t.owner.get(`/v1/shops/${t.shopId}`)).body;
    const date = nextWeekday(WED);
    const email = `guest-${Date.now()}@example.com`;
    const booked = await api().post(`/v1/public/shops/${shop.slug}/appointments`, {
      menuIds: [menu.id],
      staffId: stylist.staffId,
      startAt: jst(date, '13:00'),
      customer: { lastName: 'ゲスト', firstName: '花子', phone: '090-7777-8888', email },
    });
    expect(booked.status).toBe(201);
    await runJobs();
    const { mockOutbox } = await import('../../lib/mailer.js');
    expect(mockOutbox.filter((m) => m.to === email).map((m) => m.subject)).toContain('【テストサロン 本店】ご予約確定のお知らせ');
    const token = booked.body.manageUrl.split('/').pop();
    const res = await api().post(`/v1/public/bookings/${token}/cancel`, { reason: '体調不良' });
    expect(res.status).toBe(200);
    await runJobs();
    const mail = mockOutbox.filter((m) => m.to === email).at(-1)!;
    expect(mail.subject).toBe('【テストサロン 本店】ご予約キャンセルのお知らせ');
    expect(mail.text).toContain('以下のご予約のキャンセルを承りました');
  });

  it('tentative bookings get a receipt; reminders start once confirmed', async () => {
    const { t, stylist, menu, customerId, userId } = await setup();
    const date = nextWeekday(WED);
    const created = await t.owner.post('/v1/appointments', { shopId: t.shopId, customerId, staffId: stylist.staffId, startAt: jst(date, '16:00'), menuIds: [menu.id], status: 'tentative' });
    await runJobs();
    let msgs = await messagesOf(t, customerId);
    expect(byTemplate(msgs, 'booking_tentative')).toHaveLength(1);
    expect(byTemplate(msgs, 'booking_confirmed')).toHaveLength(0);
    expect(msgs.filter((m) => m.dedupe_key?.includes(':reminder:'))).toHaveLength(0);
    expect((lineMock.sentTo(userId)[0]!.messages[0] as { text: string }).text).toContain('ご予約リクエストを受け付けました');

    await t.owner.post(`/v1/appointments/${created.body.id}/confirm`);
    await runJobs();
    msgs = await messagesOf(t, customerId);
    expect(byTemplate(msgs, 'booking_confirmed')).toHaveLength(1);
    expect(msgs.filter((m) => m.dedupe_key?.includes(':reminder:') && m.status === 'queued')).toHaveLength(2);
  });

  it('respects shop reminder settings and skips reminders already in the past', async () => {
    const { t, stylist, menu, customerId } = await setup();
    await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { reminders: { enabled: false, confirmation: false } } });
    const date = nextWeekday(WED);
    await t.owner.post('/v1/appointments', { shopId: t.shopId, customerId, staffId: stylist.staffId, startAt: jst(date, '15:00'), menuIds: [menu.id] });
    expect(await messagesOf(t, customerId)).toHaveLength(0);

    await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { reminders: { enabled: true, confirmation: true, dayBeforeHour: 20, sameDayHoursBefore: 2 } } });
    // pretend it is already 21:00 the evening before → day-before reminder is past, same-day still ahead
    setClock(new Date(jst(prevDay(date), '21:00')));
    const appt = await t.owner.post('/v1/appointments', { shopId: t.shopId, customerId, staffId: stylist.staffId, startAt: jst(date, '18:00'), menuIds: [menu.id] });
    const msgs = (await messagesOf(t, customerId)).filter((m) => m.appointment_id === appt.body.id);
    expect(byTemplate(msgs, 'reminder_day_before')).toHaveLength(0);
    const same = byTemplate(msgs, 'reminder_same_day');
    expect(same).toHaveLength(1);
    expect(same[0]!.scheduled_at?.toISOString()).toBe(new Date(jst(date, '16:00')).toISOString());
  });

  it('cancels pending reminders on completion / no-show and ignores appointments without customer', async () => {
    const { t, stylist, menu, customerId } = await setup();
    const date = nextWeekday(WED);
    const created = await t.owner.post('/v1/appointments', { shopId: t.shopId, customerId, staffId: stylist.staffId, startAt: jst(date, '10:00'), menuIds: [menu.id] });
    await t.owner.post(`/v1/appointments/${created.body.id}/complete`);
    const msgs = await messagesOf(t, customerId);
    expect(msgs.filter((m) => m.dedupe_key?.includes(':reminder:')).every((m) => m.status === 'cancelled')).toBe(true);

    const walkIn = await t.owner.post('/v1/appointments', { shopId: t.shopId, staffId: stylist.staffId, startAt: jst(date, '14:00'), menuIds: [menu.id] });
    expect(walkIn.status).toBe(201);
    const { asSystem } = await import('../../test/helpers.js');
    const count = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('messages').select('id').where('appointment_id', '=', walkIn.body.id).execute());
    expect(count).toHaveLength(0);
  });
});
