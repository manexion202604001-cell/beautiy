import { beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  createCustomer,
  createLineChannel,
  createMenu,
  createStaffUser,
  createTenant,
  deliverWebhook,
  jst,
  lineUserId,
  nextWeekday,
  runJobs,
  textEvent,
  uploadTestFile,
  type Tenant,
} from '../../test/helpers.js';
import { lineMock } from '../messaging/providers/line.js';

beforeEach(() => lineMock.reset());

async function roleId(t: Tenant, key: string): Promise<string> {
  const roles = (await t.owner.get('/v1/roles')).body as { id: string; key: string }[];
  return roles.find((r) => r.key === key)!.id;
}

type Row = Record<string, any>;
const directory = async (t: Tenant, client = t.owner) => (await client.get(`/v1/shops/${t.shopId}/staff-directory`)).body as Row[];

describe('スタッフ screen: directory', () => {
  it('lists every staff member of the shop with login state, visibility and 担当顧客 count', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist', { displayName: '在籍 花子' });
    const noLogin = (await t.owner.post('/v1/staff', { displayName: 'ログインなし', roleId: await roleId(t, 'stylist'), shopIds: [t.shopId] })).body.staff;
    const invited = (await t.owner.post('/v1/staff', { displayName: '招待中', email: `inv-${Date.now()}@example.com`, roleId: await roleId(t, 'stylist'), shopIds: [t.shopId] })).body.staff;
    await t.owner.patch(`/v1/staff/${noLogin.id}`, { status: 'retired', retiredOn: '2026-01-31' });
    await createCustomer(t, { primaryStaffId: stylist.staffId });
    await createCustomer(t, { primaryStaffId: stylist.staffId });
    const hidden = await t.owner.put(`/v1/staff/${stylist.staffId}/shops/${t.shopId}/visibility`, { visible: false });
    expect(hidden.status).toBe(200);

    const rows = await directory(t);
    expect(rows.map((r) => r.id).sort()).toEqual([t.ownerStaffId, stylist.staffId, noLogin.id, invited.id].sort());
    const row = (id: string) => rows.find((r) => r.id === id)!;
    expect(row(stylist.staffId)).toMatchObject({ login_ready: true, customer_count: 2, is_visible_to_customer: false, notify_line: false, nickname: null, avatar_url: null });
    expect(row(t.ownerStaffId)).toMatchObject({ login_ready: true, login_email: t.email, customer_count: 0, is_visible_to_customer: true });
    expect(row(invited.id)).toMatchObject({ login_ready: false, status: 'invited' });
    expect(row(noLogin.id)).toMatchObject({ login_ready: false, login_email: null, status: 'retired', retired_on: '2026-01-31' });

    // a stylist may read the list (staff.read) but another organization cannot
    expect((await stylist.api.get(`/v1/shops/${t.shopId}/staff-directory`)).status).toBe(200);
    const stranger = await createTenant('別サロン');
    expect((await stranger.owner.get(`/v1/shops/${t.shopId}/staff-directory`)).status).toBe(404);
  });

  it('ニックネーム and プロフィール写真 are saved and shown (photo also on the staff list and to customers)', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist', { displayName: '山田 花子' });
    const { fileId } = await uploadTestFile(t.owner, { purpose: 'staff_photo', fileName: 'face.png' });
    const saved = await t.owner.put(`/v1/staff/${stylist.staffId}/extras`, { nickname: 'はなちゃん', photoFileId: fileId });
    expect(saved.status).toBe(200);
    expect(saved.body.avatar_url).toContain('/v1/files/blob/');
    const listed = (await t.owner.get('/v1/staff', { shopId: t.shopId })).body as Row[];
    const mine = listed.find((s) => s.id === stylist.staffId)!;
    expect(mine.avatar_url).toContain('/v1/files/blob/');
    expect(listed.find((s) => s.id === t.ownerStaffId)!.avatar_url).toBeNull();
    const img = await api().get(new URL(mine.avatar_url).pathname);
    expect(img.status).toBe(200);
    expect((await directory(t)).find((r) => r.id === stylist.staffId)!.nickname).toBe('はなちゃん');

    const slug = (await t.owner.get(`/v1/shops/${t.shopId}`)).body.slug;
    const pub = await api().get(`/v1/public/shops/${slug}`);
    expect(pub.body.staff.find((s: Row) => s.id === stylist.staffId).display_name).toBe('はなちゃん');

    // a file of another purpose is refused; null removes the photo and '' the nickname
    const karte = await uploadTestFile(t.owner, { purpose: 'karte_photo' });
    expect((await t.owner.put(`/v1/staff/${stylist.staffId}/extras`, { photoFileId: karte.fileId })).status).toBe(400);
    const cleared = await t.owner.put(`/v1/staff/${stylist.staffId}/extras`, { photoFileId: null, nickname: '' });
    expect(cleared.body.avatar_url).toBeNull();
    expect((await api().get(`/v1/public/shops/${slug}`)).body.staff.find((s: Row) => s.id === stylist.staffId).display_name).toBe('山田 花子');

    // only managers (or the staff member themself)
    const other = await createStaffUser(t, 'stylist');
    expect((await other.api.put(`/v1/staff/${stylist.staffId}/extras`, { nickname: 'x' })).status).toBe(403);
    expect((await stylist.api.put(`/v1/staff/${stylist.staffId}/extras`, { nickname: 'はな' })).status).toBe(200);
  });

  it('並び替え: the order given becomes the order of the staff list', async () => {
    const t = await createTenant();
    const a = await createStaffUser(t, 'stylist', { displayName: 'A' });
    const b = await createStaffUser(t, 'stylist', { displayName: 'B' });
    const order = [b.staffId, t.ownerStaffId, a.staffId];
    const res = await t.owner.put('/v1/staff/reorder', { shopId: t.shopId, staffIds: order });
    expect(res.status).toBe(200);
    expect(((await t.owner.get('/v1/staff', { shopId: t.shopId })).body as Row[]).map((s) => s.id)).toEqual(order);
    expect((await directory(t)).map((s) => s.id)).toEqual(order);

    const stranger = await createTenant('別サロン');
    expect((await t.owner.put('/v1/staff/reorder', { shopId: t.shopId, staffIds: [a.staffId, stranger.ownerStaffId] })).status).toBe(400);
    expect((await a.api.put('/v1/staff/reorder', { shopId: t.shopId, staffIds: order })).status).toBe(403);
    expect((await stranger.owner.put('/v1/staff/reorder', { shopId: t.shopId, staffIds: order })).status).toBe(404);
  });
});

describe('スタッフ screen: ログイン情報', () => {
  const login = (email: string, password: string, organizationId: string) => api().post('/v1/auth/login', { email, password, organizationId });

  it('gives a staff member without an account a login, and changes address / password later', async () => {
    const t = await createTenant();
    const created = (await t.owner.post('/v1/staff', { displayName: '新人', roleId: await roleId(t, 'stylist'), shopIds: [t.shopId] })).body.staff;
    const email = `shinjin-${Date.now()}@example.com`;
    const missing = await t.owner.put(`/v1/staff/${created.id}/credentials`, { email });
    expect(missing.status).toBe(400);
    const short = await t.owner.put(`/v1/staff/${created.id}/credentials`, { email, password: 'short' });
    expect(short.status).toBe(400);
    const set = await t.owner.put(`/v1/staff/${created.id}/credentials`, { email: email.toUpperCase(), password: 'temp-pass-1234' });
    expect(set.status).toBe(200);
    expect(set.body.email).toBe(email);
    expect((await directory(t)).find((r) => r.id === created.id)).toMatchObject({ login_ready: true, login_email: email, status: 'active' });
    const first = await login(email, 'temp-pass-1234', t.organizationId);
    expect(first.body.status).toBe('authenticated');
    expect(first.body.staffId).toBe(created.id);

    // address only
    const email2 = `renamed-${Date.now()}@example.com`;
    expect((await t.owner.put(`/v1/staff/${created.id}/credentials`, { email: email2 })).status).toBe(200);
    expect((await login(email, 'temp-pass-1234', t.organizationId)).status).toBe(401);
    expect((await login(email2, 'temp-pass-1234', t.organizationId)).body.status).toBe('authenticated');
    // password: sessions opened with the previous one end (an address-only change keeps them)
    const before = await login(email2, 'temp-pass-1234', t.organizationId);
    expect((await t.owner.put(`/v1/staff/${created.id}/credentials`, { email: email2 })).status).toBe(200);
    const kept = await api().post('/v1/auth/refresh', { refreshToken: before.body.refreshToken });
    expect(kept.status).toBe(200);
    expect((await t.owner.put(`/v1/staff/${created.id}/credentials`, { email: email2, password: 'another-pass-99' })).status).toBe(200);
    expect((await api().post('/v1/auth/refresh', { refreshToken: kept.body.refreshToken })).status).toBe(401);
    expect((await login(email2, 'temp-pass-1234', t.organizationId)).status).toBe(401);
    expect((await login(email2, 'another-pass-99', t.organizationId)).body.status).toBe('authenticated');
    // an address already in use
    expect((await t.owner.put(`/v1/staff/${created.id}/credentials`, { email: t.email })).status).toBe(409);
  });

  it('an invited staff member becomes active once a login is set', async () => {
    const t = await createTenant();
    const email = `invited-${Date.now()}@example.com`;
    const invited = (await t.owner.post('/v1/staff', { displayName: '招待中', email, roleId: await roleId(t, 'stylist'), shopIds: [t.shopId] })).body;
    expect(invited.staff.status).toBe('invited');
    const set = await t.owner.put(`/v1/staff/${invited.staff.id}/credentials`, { email, password: 'temp-pass-1234' });
    expect(set.body.status).toBe('active');
    expect((await login(email, 'temp-pass-1234', t.organizationId)).body.status).toBe('authenticated');
    // the invitation link can no longer be used to take the account over
    const token = invited.inviteUrl.split('/').pop();
    expect((await api().post('/v1/auth/accept-invite', { token, password: 'attacker-pass-1' })).status).toBe(401);
  });

  it('is refused for staff without the permission, for owners by managers, for shared accounts and across organizations', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    const manager = await createStaffUser(t, 'manager');
    const target = (await t.owner.post('/v1/staff', { displayName: '対象', roleId: await roleId(t, 'stylist'), shopIds: [t.shopId] })).body.staff;
    const body = { email: `x-${Date.now()}@example.com`, password: 'temp-pass-1234' };
    expect((await stylist.api.put(`/v1/staff/${target.id}/credentials`, body)).status).toBe(403);
    expect((await manager.api.put(`/v1/staff/${t.ownerStaffId}/credentials`, body)).status).toBe(403);
    expect((await login(t.email, t.password, t.organizationId)).body.status).toBe('authenticated');
    expect((await manager.api.put(`/v1/staff/${target.id}/credentials`, body)).status).toBe(200);

    const other = await createTenant('別サロン');
    expect((await other.owner.put(`/v1/staff/${target.id}/credentials`, { email: `y-${Date.now()}@example.com`, password: 'temp-pass-1234' })).status).toBe(404);

    // the owner of another organization, invited here and accepted: their login is theirs alone
    const shared = (await t.owner.post('/v1/staff', { displayName: '兼務', email: other.email, roleId: await roleId(t, 'stylist'), shopIds: [t.shopId] })).body;
    await api().post('/v1/auth/accept-invite', { token: shared.inviteUrl.split('/').pop(), password: other.password });
    const hijack = await t.owner.put(`/v1/staff/${shared.staff.id}/credentials`, { email: other.email, password: 'hijack-pass-123' });
    expect(hijack.status).toBe(403);
    expect(hijack.body.error.code).toBe('SHARED_ACCOUNT');
    expect((await login(other.email, other.password, other.organizationId)).body.status).toBe('authenticated');
  });
});

describe('スタッフ screen: LINE通知', () => {
  it('pushes a new booking to the staff member through the shop LINE account', async () => {
    const t = await createTenant();
    const channel = await createLineChannel(t);
    const stylist = await createStaffUser(t, 'stylist', { displayName: '通知 花子' });
    const menu = await createMenu(t, { name: 'カット' });
    const slug = (await t.owner.get(`/v1/shops/${t.shopId}`)).body.slug;
    const userId = lineUserId();

    expect((await t.owner.put(`/v1/staff/${stylist.staffId}/extras`, { notifyLine: true })).status).toBe(400);
    expect((await t.owner.put(`/v1/staff/${stylist.staffId}/extras`, { notifyLine: true, lineUserId: 'not-an-id' })).status).toBe(400);
    const on = await t.owner.put(`/v1/staff/${stylist.staffId}/extras`, { notifyLine: true, lineUserId: userId });
    expect(on.status).toBe(200);
    expect((await directory(t)).find((r) => r.id === stylist.staffId)).toMatchObject({ notify_line: true, line_user_id: userId });

    const date = nextWeekday(3);
    const booked = await api().post(`/v1/public/shops/${slug}/appointments`, {
      menuIds: [menu.id],
      staffId: stylist.staffId,
      startAt: jst(date, '13:00'),
      customer: { lastName: '通知', firstName: '太郎', phone: '09077776666' },
    });
    expect(booked.status).toBe(201);
    await runJobs();
    const sent = lineMock.sentTo(userId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.accessToken).toBe(channel.accessToken);
    const text = (sent[0]!.messages[0] as { text: string }).text;
    expect(text).toContain('【新規予約】');
    expect(text).toContain('13:00〜14:00');
    expect(text).toContain('通知 太郎 様');
    expect(text).toContain('カット');

    // a booking the staff member enters themself is not announced to them; switched off = nothing
    const customer = await createCustomer(t);
    await stylist.api.post('/v1/appointments', { shopId: t.shopId, customerId: customer.id, staffId: stylist.staffId, menuIds: [menu.id], startAt: jst(date, '15:00'), source: 'phone' });
    await runJobs();
    expect(lineMock.sentTo(userId)).toHaveLength(1);
    await t.owner.put(`/v1/staff/${stylist.staffId}/extras`, { notifyLine: false });
    await t.owner.post('/v1/appointments', { shopId: t.shopId, customerId: customer.id, staffId: stylist.staffId, menuIds: [menu.id], startAt: jst(date, '17:00'), source: 'phone' });
    await runJobs();
    expect(lineMock.sentTo(userId)).toHaveLength(1);
  });

  it('「ID確認」 sent to the official account answers with the LINE User ID', async () => {
    const t = await createTenant();
    const channel = await createLineChannel(t);
    const userId = lineUserId();
    await deliverWebhook(t, channel, [textEvent(userId, 'こんにちは')]);
    await runJobs();
    expect(lineMock.sentTo(userId).filter((s) => (s.messages[0] as { text: string }).text.includes(userId))).toHaveLength(0);
    await deliverWebhook(t, channel, [textEvent(userId, ' ID確認 ')]);
    await runJobs();
    const replies = lineMock.sentTo(userId).filter((s) => (s.messages[0] as { text: string }).text.includes(userId));
    expect(replies).toHaveLength(1);
    expect(replies[0]!.accessToken).toBe(channel.accessToken);
  });
});
