import { describe, expect, it } from 'vitest';
import {
  asSystem,
  createCustomer,
  createLineChannel,
  createStaffUser,
  createTenant,
  daysAgo,
  deliverWebhook,
  insertAppointment,
  lineFollower,
  lineUserId,
  messagesOf,
  runJobs,
  textEvent,
  updateCustomer,
} from '../../test/helpers.js';
import { mockOutbox } from '../../lib/mailer.js';
import { lineMock } from './providers/line.js';

/** メッセージ画面 (会話一覧 / 会話ヘッダ / 記録のみの送信 / 既読) */
describe('conversation list for the messages screen', () => {
  it('filters by staff in charge and customer name, and returns the staff tag and LINE picture', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist', { displayName: '担当 花子' });
    const ch = await createLineChannel(t);
    const userId = lineUserId();
    lineMock.profiles.set(userId, { displayName: 'はなLINE', pictureUrl: 'https://example.com/p.png' });
    const { customerId: lineCustomer } = await lineFollower(t, ch, userId);
    await updateCustomer(t, lineCustomer, { last_name: '山田', first_name: '花子', last_name_kana: 'ヤマダ', first_name_kana: 'ハナコ', primary_staff_id: stylist.staffId, primary_shop_id: t.shopId });
    const other = await createCustomer(t, { lastName: '佐藤', firstName: '次郎', lastNameKana: 'サトウ', firstNameKana: 'ジロウ' });

    await deliverWebhook(t, ch, [textEvent(userId, '予約できますか？')]);
    expect((await t.owner.post('/v1/messages/send', { customerId: other.id, body: 'ご来店ありがとうございました', deliver: false })).status).toBe(201);

    const all = await t.owner.get('/v1/messages/inbox');
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(2);
    const mineRow = all.body.items.find((i: { customer_id: string }) => i.customer_id === lineCustomer);
    expect(mineRow).toMatchObject({ customer_name: '山田 花子', customer_staff_name: '担当 花子', customer_avatar: 'https://example.com/p.png', unread_count: 1 });
    const otherRow = all.body.items.find((i: { customer_id: string }) => i.customer_id === other.id);
    expect(otherRow).toMatchObject({ customer_staff_name: null, customer_avatar: null, direction: 'outbound', body: 'ご来店ありがとうございました' });

    // 自分宛のみ: the caller's own customers
    const mine = await stylist.api.get('/v1/messages/inbox', { mine: 'true' });
    expect(mine.body.items.map((i: { customer_id: string }) => i.customer_id)).toEqual([lineCustomer]);
    expect((await t.owner.get('/v1/messages/inbox', { mine: 'true' })).body.items).toHaveLength(0);

    // 最近の担当 follows the reservation history: a completed visit with another staff member takes over
    // (a nominated visit wins over a later visit without nomination), cancelled visits do not count
    const second = await createStaffUser(t, 'stylist', { displayName: '二人目 太郎' });
    await insertAppointment(t.organizationId, { shopId: t.shopId, customerId: other.id, staffId: stylist.staffId, startAt: daysAgo(30), status: 'completed', isNominated: true });
    await insertAppointment(t.organizationId, { shopId: t.shopId, customerId: other.id, staffId: second.staffId, startAt: daysAgo(10), status: 'completed' });
    await insertAppointment(t.organizationId, { shopId: t.shopId, customerId: lineCustomer, staffId: second.staffId, startAt: daysAgo(5), status: 'completed' });
    await insertAppointment(t.organizationId, { shopId: t.shopId, customerId: lineCustomer, staffId: stylist.staffId, startAt: daysAgo(1), status: 'cancelled' });
    const after = await t.owner.get('/v1/messages/inbox');
    const staffOf = (id: string) => after.body.items.find((i: { customer_id: string }) => i.customer_id === id).customer_staff_name;
    expect(staffOf(other.id)).toBe('担当 花子');
    expect(staffOf(lineCustomer)).toBe('二人目 太郎');
    expect((await stylist.api.get('/v1/messages/inbox', { mine: 'true' })).body.items.map((i: { customer_id: string }) => i.customer_id)).toEqual([other.id]);
    expect((await second.api.get('/v1/messages/inbox', { mine: 'true' })).body.items.map((i: { customer_id: string }) => i.customer_id)).toEqual([lineCustomer]);
    expect((await t.owner.get('/v1/messages/thread', { customerId: lineCustomer })).body.customer.staff_name).toBe('二人目 太郎');

    // name / kana search
    expect((await t.owner.get('/v1/messages/inbox', { q: 'さとう' })).body.items.map((i: { customer_id: string }) => i.customer_id)).toEqual([other.id]);
    expect((await t.owner.get('/v1/messages/inbox', { q: '山田' })).body.items.map((i: { customer_id: string }) => i.customer_id)).toEqual([lineCustomer]);
    expect((await t.owner.get('/v1/messages/inbox', { q: '該当なし' })).body.items).toHaveLength(0);
  });
});

describe('conversation header and thread notes', () => {
  it('reports the linked LINE account and whether a LINE message would be delivered', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const userId = lineUserId();
    lineMock.profiles.set(userId, { displayName: 'LINEの名前', pictureUrl: 'https://example.com/b.png' });
    const { customerId } = await lineFollower(t, ch, userId);
    await updateCustomer(t, customerId, { last_name: '連携', first_name: '済み', primary_staff_id: t.ownerStaffId });

    const linked = await t.owner.get('/v1/messages/thread', { customerId });
    expect(linked.status).toBe(200);
    expect(linked.body.customer).toMatchObject({ id: customerId, name: '連携 済み', status: 'active' });
    expect(typeof linked.body.customer.staff_name).toBe('string');
    expect(linked.body.line).toEqual({ display_name: 'LINEの名前', picture_url: 'https://example.com/b.png', deliverable: true });

    // the customer stops LINE notifications → linked, but a message would not arrive
    await t.owner.put(`/v1/customers/${customerId}/channel-preferences`, { channels: [{ channel: 'line', transactionalAllowed: false }] });
    expect((await t.owner.get('/v1/messages/thread', { customerId })).body.line).toMatchObject({ display_name: 'LINEの名前', deliverable: false });

    const plain = await createCustomer(t);
    const unlinked = await t.owner.get('/v1/messages/thread', { customerId: plain.id });
    expect(unlinked.body.line).toBeNull();
    expect(unlinked.body.customer.staff_name).toBeNull();
  });

  it('records a note on the thread without delivering it', async () => {
    const t = await createTenant();
    const email = `note-${Date.now()}@example.com`;
    const customer = await createCustomer(t, { email, phone: '090-1234-5678' });

    const note = await t.owner.post('/v1/messages/send', { customerId: customer.id, body: '本日はありがとうございました', deliver: false });
    expect(note.status).toBe(201);
    expect(note.body).toMatchObject({
      channel: 'note',
      direction: 'outbound',
      category: 'conversation',
      status: 'skipped',
      skip_reason: 'note_only',
      body: '本日はありがとうございました',
      sent_by_staff_id: t.ownerStaffId,
    });
    expect(typeof note.body.sent_by_staff_name).toBe('string');

    // nothing is queued and nothing reaches the customer, even though an e-mail address and phone exist
    const jobs = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('jobs').select('id').where('type', '=', 'message.deliver').execute());
    expect(jobs).toHaveLength(0);
    await runJobs();
    expect(mockOutbox.filter((m) => m.to === email)).toHaveLength(0);
    const rows = await messagesOf(t, customer.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'skipped', channel: 'note', sent_at: null, recipient: null });

    // listed on the thread and as the latest message of the conversation
    const thread = await t.owner.get('/v1/messages', { customerId: customer.id });
    expect(thread.body.items.map((m: { id: string }) => m.id)).toEqual([note.body.id]);
    expect((await t.owner.get('/v1/messages/inbox')).body.items[0]).toMatchObject({ customer_id: customer.id, channel: 'note', body: '本日はありがとうございました' });

    // a note is never a template / channel message, and cannot be resent as a delivery
    expect((await t.owner.post('/v1/messages/send', { customerId: customer.id, body: 'x', deliver: false, channel: 'line' })).status).toBe(400);
    expect((await t.owner.post('/v1/messages/send', { customerId: customer.id, deliver: false })).status).toBe(400);
    expect((await t.owner.post(`/v1/messages/${note.body.id}/retry`)).status).toBe(422);

    // permissions
    const assistant = await createStaffUser(t, 'assistant');
    expect((await assistant.api.post('/v1/messages/send', { customerId: customer.id, body: 'x', deliver: false })).status).toBe(403);
  });

  it('marks every unread message of the customer as read', async () => {
    const t = await createTenant();
    const other = await createTenant();
    const ch = await createLineChannel(t);
    const a = await lineFollower(t, ch);
    const b = await lineFollower(t, ch);
    await deliverWebhook(t, ch, [textEvent(a.userId, '1'), textEvent(a.userId, '2'), textEvent(b.userId, '別の人')]);
    expect((await t.owner.get('/v1/messages/unread-count')).body).toEqual({ count: 3 });

    const read = await t.owner.post('/v1/messages/read-thread', { customerId: a.customerId });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ ok: true, updated: 2 });
    expect((await t.owner.get('/v1/messages/unread-count')).body).toEqual({ count: 1 });
    expect((await t.owner.post('/v1/messages/read-thread', { customerId: a.customerId })).body).toEqual({ ok: true, updated: 0 });

    // tenant isolation / permissions
    expect((await other.owner.post('/v1/messages/read-thread', { customerId: b.customerId })).status).toBe(404);
    expect((await other.owner.get('/v1/messages/thread', { customerId: b.customerId })).status).toBe(404);
    const assistant = await createStaffUser(t, 'assistant');
    expect((await assistant.api.post('/v1/messages/read-thread', { customerId: b.customerId })).status).toBe(403);
    expect((await assistant.api.get('/v1/messages/thread', { customerId: b.customerId })).status).toBe(403);
    expect((await t.owner.get('/v1/messages/unread-count')).body).toEqual({ count: 1 });
  });
});
