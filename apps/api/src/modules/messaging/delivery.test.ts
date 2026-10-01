import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { mockOutbox, mockSmsOutbox } from '../../lib/mailer.js';
import { formatJst } from '../../lib/time.js';
import {
  api,
  asSystem,
  createCustomer,
  createLineChannel,
  createMenu,
  createStaffUser,
  createTenant,
  deliverWebhook,
  jst,
  jstDate,
  lineEvent,
  lineFollower,
  makeMessagingJobsDue,
  messagesOf,
  nextWeekday,
  runJobs,
  setClock,
  textEvent,
  updateCustomer,
  type Tenant,
} from '../../test/helpers.js';
import { queueMessage, type QueueMessageInput } from './api.js';
import { lineMock } from './providers/line.js';
import { renderMessage } from './templates.js';

beforeEach(() => lineMock.reset());
afterEach(() => setClock(null));

function queue(t: Tenant, input: QueueMessageInput) {
  return asSystem(t.organizationId, (ctx) => queueMessage(ctx, input));
}

async function message(t: Tenant, id: string) {
  return asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('messages').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
}

function uniqueEmail() {
  return `c-${Math.random().toString(36).slice(2, 10)}@example.com`;
}

describe('renderMessage', () => {
  it('substitutes variables and conditional sections', () => {
    const tpl = '{{customer.name}}様\n{{#appointment.manageUrl}}\n変更はこちら\n{{appointment.manageUrl}}\n{{/appointment.manageUrl}}\n{{^cancel.byCustomer}}店舗都合{{/cancel.byCustomer}}\n{{shop.name}}';
    expect(renderMessage(tpl, { customer: { name: '山田 花子' }, appointment: { manageUrl: 'https://x/y' }, shop: { name: 'サロン' } })).toBe(
      '山田 花子様\n\n変更はこちら\nhttps://x/y\n\n店舗都合\nサロン',
    );
    expect(renderMessage(tpl, { customer: { name: 'A' }, cancel: { byCustomer: true }, shop: { name: 'S' } })).toBe('A様\n\nS');
    expect(renderMessage('{{unknown.var}}です', {})).toBe('です');
  });
});

describe('message.deliver', () => {
  it('auto-selects LINE → email → SMS and honours unfollow', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const { userId, customerId } = await lineFollower(t, ch);
    const email = uniqueEmail();
    await updateCustomer(t, customerId, { email, last_name: '自動', first_name: '選択' });

    const r1 = await queue(t, { customerId, category: 'transactional', body: '{{customer.name}}様 こんにちは' });
    await runJobs();
    const m1 = await message(t, r1.messageId!);
    expect(m1).toMatchObject({ status: 'sent', channel: 'line', recipient: userId, line_channel_id: ch.id, attempts: 1 });
    expect(m1.body).toBe('自動 選択様 こんにちは');
    expect(lineMock.sentTo(userId)).toHaveLength(1);

    await deliverWebhook(t, ch, [lineEvent('unfollow', userId)]);
    const r2 = await queue(t, { customerId, category: 'transactional', body: 'メールで届きます' });
    await runJobs();
    expect(await message(t, r2.messageId!)).toMatchObject({ status: 'sent', channel: 'email', recipient: email });
    expect(mockOutbox.find((m) => m.to === email)?.text).toBe('メールで届きます');

    const phoneOnly = await createCustomer(t, { phone: '090-3333-4444' });
    const r3 = await queue(t, { customerId: phoneOnly.id, category: 'transactional', body: 'SMSです' });
    await runJobs();
    expect(await message(t, r3.messageId!)).toMatchObject({ status: 'sent', channel: 'sms', recipient: '+819033334444' });
    expect(mockSmsOutbox.some((m) => m.to === '+819033334444' && m.text === 'SMSです')).toBe(true);
  });

  it('skips by consent, opt-out, missing contact and customer state', async () => {
    const t = await createTenant();
    const email = uniqueEmail();
    const c = await createCustomer(t, { email });
    await t.owner.put(`/v1/customers/${c.id}/channel-preferences`, { channels: [{ channel: 'email', marketingAllowed: false }] });
    const mk = await queue(t, { customerId: c.id, category: 'marketing', body: 'セール' });
    const tx = await queue(t, { customerId: c.id, category: 'transactional', body: '予約確認' });

    const optOut = await createCustomer(t, { email: uniqueEmail(), marketingOptIn: false });
    const mk2 = await queue(t, { customerId: optOut.id, category: 'marketing', body: 'セール' });

    const noContact = await createCustomer(t);
    const nc = await queue(t, { customerId: noContact.id, category: 'transactional', body: 'x' });
    const lineOnly = await queue(t, { customerId: c.id, category: 'transactional', body: 'x', channel: 'line' });

    const blocked = await createCustomer(t, { email: uniqueEmail() });
    await updateCustomer(t, blocked.id, { status: 'blocked' });
    const bl = await queue(t, { customerId: blocked.id, category: 'transactional', body: 'x' });

    await runJobs();
    expect(await message(t, mk.messageId!)).toMatchObject({ status: 'skipped', skip_reason: 'opted_out' });
    expect(await message(t, tx.messageId!)).toMatchObject({ status: 'sent', channel: 'email' });
    expect(await message(t, mk2.messageId!)).toMatchObject({ status: 'skipped', skip_reason: 'opted_out' });
    expect(await message(t, nc.messageId!)).toMatchObject({ status: 'skipped', skip_reason: 'no_contact' });
    expect(await message(t, lineOnly.messageId!)).toMatchObject({ status: 'skipped', skip_reason: 'no_line_identity' });
    expect(await message(t, bl.messageId!)).toMatchObject({ status: 'skipped', skip_reason: 'customer_blocked' });

    // transactional opt-out on email
    await t.owner.put(`/v1/customers/${c.id}/channel-preferences`, { channels: [{ channel: 'email', transactionalAllowed: false }] });
    const tx2 = await queue(t, { customerId: c.id, category: 'transactional', body: '予約確認2' });
    await runJobs();
    expect(await message(t, tx2.messageId!)).toMatchObject({ status: 'skipped', skip_reason: 'opted_out' });
  });

  it('defers marketing messages during quiet hours (21:00–09:00 local) until 09:00', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const { userId, customerId } = await lineFollower(t, ch);
    const day = jstDate(10);
    const nextDay = jstDate(11);
    setClock(new Date(`${day}T22:30:00+09:00`));
    const mk = await queue(t, { customerId, category: 'marketing', body: '夜間のお知らせ' });
    const tx = await queue(t, { customerId, category: 'transactional', body: '予約確認は夜でも送る' });
    await runJobs();
    const deferred = await message(t, mk.messageId!);
    expect(deferred.status).toBe('queued');
    expect(deferred.scheduled_at?.toISOString()).toBe(new Date(`${nextDay}T09:00:00+09:00`).toISOString());
    expect(await message(t, tx.messageId!)).toMatchObject({ status: 'sent' });
    expect(lineMock.sentTo(userId)).toHaveLength(1);
    const job = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('jobs').select(['run_at', 'state']).where(sql<boolean>`payload->>'messageId' = ${mk.messageId}`).where('state', '=', 'queued').executeTakeFirstOrThrow(),
    );
    expect(job.run_at.toISOString()).toBe(new Date(`${nextDay}T09:00:00+09:00`).toISOString());

    // early morning is quiet too
    setClock(new Date(`${nextDay}T08:59:00+09:00`));
    await makeMessagingJobsDue(t);
    await runJobs();
    expect((await message(t, mk.messageId!)).status).toBe('queued');

    setClock(new Date(`${nextDay}T09:00:30+09:00`));
    await makeMessagingJobsDue(t);
    await runJobs();
    expect(await message(t, mk.messageId!)).toMatchObject({ status: 'sent', channel: 'line' });
    expect(lineMock.sentTo(userId)).toHaveLength(2);
  });

  it('retries transient provider failures with the same X-Line-Retry-Key, then succeeds', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const { userId, customerId } = await lineFollower(t, ch);
    lineMock.failNext('retry', 1, { to: userId });
    const r = await queue(t, { customerId, category: 'transactional', body: 'リトライ' });
    await runJobs();
    const failedOnce = await message(t, r.messageId!);
    expect(failedOnce).toMatchObject({ status: 'queued', attempts: 1 });
    expect(failedOnce.error).toContain('LINE mock failure');
    expect(lineMock.sentTo(userId)).toHaveLength(0);

    await makeMessagingJobsDue(t);
    await runJobs();
    const sent = await message(t, r.messageId!);
    expect(sent).toMatchObject({ status: 'sent', attempts: 2, error: null });
    expect(sent.provider_message_id).toBeTruthy();
    expect(lineMock.sentTo(userId)).toHaveLength(1);
    expect(lineMock.sentTo(userId)[0]!.retryKey).toBe(r.messageId);
    const events = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('domain_events').select(['event_type', 'payload']).where('aggregate_id', '=', r.messageId!).execute(),
    );
    expect(events.map((e) => e.event_type)).toEqual(['message.sent']);

    // a crash after the provider call (message left 'sending') replays with the same retry key → no duplicate
    await asSystem(t.organizationId, async (ctx) => {
      await ctx.trx.updateTable('messages').set({ status: 'sending' }).where('id', '=', r.messageId!).execute();
      const { enqueueDelivery } = await import('./api.js');
      await enqueueDelivery(ctx, r.messageId!, undefined, ':crash');
    });
    await runJobs();
    expect(lineMock.sentTo(userId)).toHaveLength(1);
    expect((await message(t, r.messageId!)).status).toBe('sent');
  });

  it('fails permanently on 4xx, emits message.failed and supports manual retry', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const { userId, customerId } = await lineFollower(t, ch);
    lineMock.failNext('permanent', 1, { status: 400, to: userId });
    const r = await queue(t, { customerId, category: 'transactional', body: '失敗' });
    await runJobs();
    const failed = await message(t, r.messageId!);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('400');
    const ev = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('domain_events').select('payload').where('aggregate_id', '=', r.messageId!).where('event_type', '=', 'message.failed').executeTakeFirstOrThrow());
    expect(ev.payload).toMatchObject({ messageId: r.messageId, customerId, channel: 'line' });

    const notRetryable = await t.owner.post(`/v1/messages/${r.messageId}/retry`);
    expect(notRetryable.status).toBe(200);
    expect(notRetryable.body.status).toBe('queued');
    await runJobs();
    expect((await message(t, r.messageId!)).status).toBe('sent');
    expect(lineMock.sentTo(userId)).toHaveLength(1);
    const again = await t.owner.post(`/v1/messages/${r.messageId}/retry`);
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('NOT_RETRYABLE');
  });

  it('marks the message failed when retries are exhausted', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const { userId, customerId } = await lineFollower(t, ch);
    lineMock.failNext('retry', 3, { to: userId });
    const r = await queue(t, { customerId, category: 'transactional', body: 'x' });
    await asSystem(t.organizationId, (ctx) => ctx.trx.updateTable('jobs').set({ max_attempts: 2 }).where(sql<boolean>`payload->>'messageId' = ${r.messageId}`).execute());
    await runJobs();
    await makeMessagingJobsDue(t);
    await runJobs();
    const m = await message(t, r.messageId!);
    expect(m.status).toBe('failed');
    expect(m.attempts).toBe(2);
  });

  it('renders system templates (shop override first) and handles disabled / missing templates', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const { userId, customerId } = await lineFollower(t, ch);
    await updateCustomer(t, customerId, { last_name: '佐藤', first_name: '一郎' });
    const r = await queue(t, { customerId, shopId: t.shopId, category: 'marketing', templateKey: 'dormant_followup', vars: { extra: 1 } });
    await runJobs();
    const m = await message(t, r.messageId!);
    expect(m.status).toBe('sent');
    expect(m.body).toContain('佐藤 一郎様');
    expect(m.body).toContain('テストサロン 本店');
    expect(m.template_id).toBeTruthy();

    const override = await t.owner.post('/v1/message-templates', { shopId: t.shopId, key: 'dormant_followup', name: '店舗版', channel: 'line', category: 'marketing', body: '{{shop.name}}限定: {{customer.lastName}}様' });
    expect(override.status).toBe(201);
    const r2 = await queue(t, { customerId, shopId: t.shopId, category: 'marketing', templateKey: 'dormant_followup' });
    await runJobs();
    expect((await message(t, r2.messageId!)).body).toBe('テストサロン 本店限定: 佐藤様');
    expect(lineMock.sentTo(userId)).toHaveLength(2);

    await t.owner.patch(`/v1/message-templates/${override.body.id}`, { status: 'inactive' });
    const r3 = await queue(t, { customerId, shopId: t.shopId, category: 'marketing', templateKey: 'dormant_followup' });
    const r4 = await queue(t, { customerId, category: 'transactional', templateKey: 'no_such_template' });
    await runJobs();
    expect(await message(t, r3.messageId!)).toMatchObject({ status: 'skipped', skip_reason: 'template_disabled' });
    expect(await message(t, r4.messageId!)).toMatchObject({ status: 'failed', error: 'template_not_found:no_such_template' });
  });

  it('renders appointment variables in booking notifications', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const stylist = await createStaffUser(t, 'stylist', { displayName: '担当 次郎' });
    const menu = await createMenu(t, { name: 'カット+トリートメント' });
    const { userId, customerId } = await lineFollower(t, ch);
    await updateCustomer(t, customerId, { last_name: '予約', first_name: '太郎' });
    const date = nextWeekday(3);
    const appt = await t.owner.post('/v1/appointments', { shopId: t.shopId, customerId, staffId: stylist.staffId, startAt: jst(date, '15:00'), menuIds: [menu.id] });
    expect(appt.status).toBe(201);
    await runJobs();
    const sent = lineMock.sentTo(userId);
    expect(sent).toHaveLength(1);
    const text = (sent[0]!.messages[0] as { text: string }).text;
    expect(text).toContain('予約 太郎様');
    expect(text).toContain(`■日時：${formatJst(new Date(jst(date, '15:00')), 'M月d日(EEE) H:mm')}`);
    expect(text).toContain('■メニュー：カット+トリートメント');
    expect(text).toContain('■担当：担当 次郎（指名）');
    expect(text).toContain(`■予約番号：${appt.body.booking_reference}`);
    expect(text).toMatch(/\/b\/manage\/[\w-]+/);
    expect(text).toContain('テストサロン 本店');
    // the manage link works
    const token = /\/b\/manage\/([\w-]+)/.exec(text)![1];
    const view = await api().get(`/v1/public/bookings/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.bookingReference).toBe(appt.body.booking_reference);
  });
});

describe('1:1 messaging API', () => {
  it('sends, lists the conversation with pagination, shows the inbox and marks read', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const { userId, customerId } = await lineFollower(t, ch);
    for (const body of ['1通目', '2通目', '3通目']) {
      const res = await t.owner.post('/v1/messages/send', { customerId, body });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'queued', category: 'conversation', sent_by_staff_id: t.ownerStaffId });
    }
    await runJobs();
    expect(lineMock.sentTo(userId)).toHaveLength(3);
    await deliverWebhook(t, ch, [textEvent(userId, 'ありがとうございます'), textEvent(userId, '予約できますか？')]);

    const page1 = await t.owner.get('/v1/messages', { customerId, limit: 2 });
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.items[0].body).toBe('予約できますか？');
    const page2 = await t.owner.get('/v1/messages', { customerId, limit: 10, cursor: page1.body.nextCursor });
    expect(page2.body.items).toHaveLength(3);
    expect(page2.body.nextCursor).toBeNull();
    expect(page2.body.items[2].body).toBe('1通目');

    const inbox = await t.owner.get('/v1/messages/inbox');
    expect(inbox.status).toBe(200);
    const row = inbox.body.items.find((i: { customer_id: string }) => i.customer_id === customerId);
    expect(row).toMatchObject({ body: '予約できますか？', direction: 'inbound', unread_count: 2 });
    expect((await t.owner.get('/v1/messages/inbox', { unreadOnly: 'true' })).body.items).toHaveLength(1);

    const read = await t.owner.post(`/v1/messages/${row.id}/read`);
    expect(read.body).toEqual({ ok: true, updated: 2 });
    const inbox2 = await t.owner.get('/v1/messages/inbox');
    expect(inbox2.body.items[0].unread_count).toBe(0);
    expect((await t.owner.get('/v1/messages/inbox', { unreadOnly: 'true' })).body.items).toHaveLength(0);
    const outbound = page2.body.items[0];
    expect((await t.owner.post(`/v1/messages/${outbound.id}/read`)).status).toBe(422);

    // send by template with variables
    const tpl = await t.owner.post('/v1/message-templates', { name: '個別', channel: 'line', category: 'other', body: '{{customer.name}}様、{{note}}' });
    const viaTpl = await t.owner.post('/v1/messages/send', { customerId, templateId: tpl.body.id, vars: { note: 'お待ちしています' } });
    await runJobs();
    expect((await message(t, viaTpl.body.id)).body).toMatch(/様、お待ちしています$/);
  });

  it('enforces permissions, customer visibility and tenant isolation', async () => {
    const t = await createTenant();
    const other = await createTenant();
    const customer = await createCustomer(t, { email: uniqueEmail() });
    const sent = await t.owner.post('/v1/messages/send', { customerId: customer.id, body: 'hi' });
    const assistant = await createStaffUser(t, 'assistant');
    expect((await assistant.api.post('/v1/messages/send', { customerId: customer.id, body: 'x' })).status).toBe(403);
    expect((await assistant.api.get('/v1/messages/inbox')).status).toBe(403);
    expect((await assistant.api.get('/v1/messages', { customerId: customer.id })).status).toBe(403);

    // staff of another shop cannot see this customer's conversation
    const shop2 = await t.owner.post('/v1/shops', { name: '2号店', slug: `s2-${Date.now()}` });
    const stylist2 = await createStaffUser(t, 'stylist', { shopIds: [shop2.body.id] });
    expect((await stylist2.api.get('/v1/messages', { customerId: customer.id })).status).toBe(404);
    expect((await stylist2.api.get(`/v1/messages/${sent.body.id}`)).status).toBe(404);
    expect((await stylist2.api.post('/v1/messages/send', { customerId: customer.id, body: 'x' })).status).toBe(404);

    expect((await other.owner.get(`/v1/messages/${sent.body.id}`)).status).toBe(404);
    expect((await other.owner.get('/v1/messages', { customerId: customer.id })).status).toBe(404);
    expect((await other.owner.post('/v1/messages/send', { customerId: customer.id, body: 'x' })).status).toBe(404);
    expect((await other.owner.get('/v1/messages/inbox')).body.items).toHaveLength(0);
    // validation
    expect((await t.owner.post('/v1/messages/send', { customerId: customer.id })).status).toBe(400);
  });
});

describe('channel preferences & unsubscribe', () => {
  it('lets staff and the customer manage notification preferences', async () => {
    const t = await createTenant();
    const shop = (await t.owner.get(`/v1/shops/${t.shopId}`)).body;
    const login = await api().post(`/v1/public/shops/${shop.slug}/auth/line`, { idToken: 'mock:Uprefcustomer01:プリファ' });
    expect(login.status).toBe(200);
    const me = api(login.body.token);
    const get = await me.get('/v1/public/me/notification-preferences');
    expect(get.status).toBe(200);
    expect(get.body.marketingOptIn).toBe(true);
    expect(get.body.channels).toHaveLength(3);
    const put = await me.put('/v1/public/me/notification-preferences', { marketingOptIn: false, channels: [{ channel: 'line', marketingAllowed: false }] });
    expect(put.status).toBe(200);
    expect(put.body.marketingOptIn).toBe(false);
    expect(put.body.channels.find((c: { channel: string }) => c.channel === 'line')).toMatchObject({ marketingAllowed: false, transactionalAllowed: true, source: 'customer_request' });
    // staff view reflects it
    const staffView = await t.owner.get(`/v1/customers/${login.body.customerId}/channel-preferences`);
    expect(staffView.body.marketingOptIn).toBe(false);
    // staff cannot use the customer route and vice versa
    expect((await t.owner.get('/v1/public/me/notification-preferences')).status).toBe(403);
    expect((await me.get(`/v1/customers/${login.body.customerId}/channel-preferences`)).status).toBe(403);
    const reception = await createStaffUser(t, 'assistant');
    expect((await reception.api.put(`/v1/customers/${login.body.customerId}/channel-preferences`, { marketingOptIn: true })).status).toBe(403);
  });

  it('appends an unsubscribe link to marketing e-mails which opts the customer out', async () => {
    const t = await createTenant();
    const email = uniqueEmail();
    const c = await createCustomer(t, { email });
    const r = await queue(t, { customerId: c.id, category: 'marketing', templateKey: 'birthday' });
    await runJobs();
    const m = await message(t, r.messageId!);
    expect(m).toMatchObject({ status: 'sent', channel: 'email' });
    const mail = mockOutbox.find((x) => x.to === email)!;
    expect(mail.subject).toBe('【テストサロン 本店】お誕生日おめでとうございます');
    expect(mail.text).toContain('配信停止をご希望の方はこちら');
    const token = decodeURIComponent(/unsubscribe\?token=([^\s]+)/.exec(mail.text)![1]!);

    const info = await api().get('/v1/public/unsubscribe', { token });
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ channel: 'email', marketingAllowed: true });
    expect(info.body.email).not.toBe(email);
    const res = await api().post('/v1/public/unsubscribe', { token });
    expect(res.status).toBe(200);
    const prefs = (await t.owner.get(`/v1/customers/${c.id}/channel-preferences`)).body;
    expect(prefs.channels.find((x: { channel: string }) => x.channel === 'email')).toMatchObject({ marketingAllowed: false, source: 'unsubscribe_link' });
    expect(prefs.marketingOptIn).toBe(true);
    await api().post('/v1/public/unsubscribe', { token, scope: 'all' });
    expect((await t.owner.get(`/v1/customers/${c.id}/channel-preferences`)).body.marketingOptIn).toBe(false);

    const r2 = await queue(t, { customerId: c.id, category: 'marketing', body: 'もう届かない' });
    await runJobs();
    expect((await message(t, r2.messageId!)).status).toBe('skipped');
    expect((await api().post('/v1/public/unsubscribe', { token: `${token}x` })).status).toBe(401);
    // transactional e-mails carry no unsubscribe footer
    const r3 = await queue(t, { customerId: c.id, category: 'transactional', body: '予約確認' });
    await runJobs();
    expect((await message(t, r3.messageId!)).body).toBe('予約確認');
  });
});

describe('message templates API', () => {
  it('seeds system templates and supports CRUD + preview', async () => {
    const t = await createTenant();
    const list = await t.owner.get('/v1/message-templates');
    expect(list.status).toBe(200);
    const keys = new Set(list.body.filter((x: { key: string | null }) => x.key).map((x: { key: string }) => x.key));
    for (const k of ['booking_confirmed', 'booking_changed', 'booking_cancelled', 'reminder_day_before', 'reminder_same_day', 'review_request', 'followup_after_visit', 'dormant_followup', 'first_visit_followup', 'birthday', 'welcome']) {
      expect(keys.has(k)).toBe(true);
    }
    const lineEmail = list.body.filter((x: { key: string }) => x.key === 'booking_confirmed').map((x: { channel: string }) => x.channel).sort();
    expect(lineEmail).toEqual(['email', 'line']);

    const preview = await t.owner.post('/v1/message-templates/preview', { templateId: list.body.find((x: { key: string; channel: string }) => x.key === 'booking_confirmed' && x.channel === 'email').id });
    expect(preview.status).toBe(200);
    expect(preview.body.body).toContain('山田 花子様');
    expect(preview.body.body).toContain('テストサロン 本店');
    expect(preview.body.subject).toBe('【テストサロン 本店】ご予約確定のお知らせ');
    expect(preview.body.unknownVariables).toEqual([]);
    const adhoc = await t.owner.post('/v1/message-templates/preview', { body: '{{customer.name}} {{foo.bar}}' });
    expect(adhoc.body.unknownVariables).toEqual(['foo.bar']);

    const customer = await createCustomer(t, { lastName: '実在', firstName: '顧客' });
    const real = await t.owner.post('/v1/message-templates/preview', { body: '{{customer.name}}様', customerId: customer.id });
    expect(real.body.body).toBe('実在 顧客様');

    expect((await t.owner.post('/v1/message-templates', { name: 'メール', channel: 'email', body: 'x' })).status).toBe(400);
    const created = await t.owner.post('/v1/message-templates', { name: '新メニュー案内', channel: 'line', category: 'marketing', body: '新メニューのご案内' });
    expect(created.status).toBe(201);
    expect(created.body.isSystem).toBe(false);
    const updated = await t.owner.patch(`/v1/message-templates/${created.body.id}`, { body: '{{customer.name}}様 新メニュー' });
    expect(updated.body.variables).toEqual(['customer.name']);
    expect((await t.owner.delete(`/v1/message-templates/${created.body.id}`)).status).toBe(204);
    const system = list.body.find((x: { key: string }) => x.key === 'birthday');
    const del = await t.owner.delete(`/v1/message-templates/${system.id}`);
    expect(del.status).toBe(422);
    expect(del.body.error.code).toBe('SYSTEM_TEMPLATE');
  });

  it('restricts template management and isolates tenants', async () => {
    const t = await createTenant();
    const other = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    // stylists can read (for 1:1 sending) but not manage
    expect((await stylist.api.get('/v1/message-templates')).status).toBe(200);
    expect((await stylist.api.post('/v1/message-templates', { name: 'x', body: 'x' })).status).toBe(403);
    const tpl = (await t.owner.get('/v1/message-templates')).body[0];
    expect((await stylist.api.patch(`/v1/message-templates/${tpl.id}`, { body: 'x' })).status).toBe(403);
    expect((await other.owner.get(`/v1/message-templates/${tpl.id}`)).status).toBe(404);
    expect((await other.owner.patch(`/v1/message-templates/${tpl.id}`, { body: 'x' })).status).toBe(404);
    const assistant = await createStaffUser(t, 'assistant');
    expect((await assistant.api.get('/v1/message-templates')).status).toBe(403);
  });
});

it('keeps conversation history visible via messagesOf helper', async () => {
  const t = await createTenant();
  const c = await createCustomer(t, { email: uniqueEmail() });
  await queue(t, { customerId: c.id, category: 'system', body: 'system notice' });
  await runJobs();
  const msgs = await messagesOf(t, c.id);
  expect(msgs[0]).toMatchObject({ status: 'sent', category: 'system', channel: 'email' });
});
