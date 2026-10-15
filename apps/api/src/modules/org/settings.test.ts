import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mockOutbox } from '../../lib/mailer.js';
import { api, createCustomer, createMenu, createStaffUser, createTenant, jst, nextWeekday } from '../../test/helpers.js';

const WED = 3;

describe('first-run signup (初期設定)', () => {
  it('creates the organization without URL ids and stores the owner profile and shop address', async () => {
    const suffix = randomUUID().slice(0, 8);
    const res = await api().post('/v1/auth/signup', {
      organizationName: '株式会社サンプル',
      shopName: 'ビューティーサロン 渋谷店',
      ownerName: 'オーナー 花子',
      email: `first-${suffix}@example.com`,
      password: 'password-1234',
      phone: '03-0000-0000',
      shopPostalCode: '150-0001',
      shopAddressLine: '東京都渋谷区1-2-3',
      shopEmail: 'shop@example.com',
      ownerProfile: { ownerType: 'company', companyName: '株式会社サンプル', companyPostalCode: '150-0002', companyPhone: '03-1111-2222', companyAddress: '東京都渋谷区4-5-6', companyEmail: 'info@example.com' },
    });
    expect(res.status).toBe(201);
    const owner = api(res.body.auth.accessToken);
    const org = await owner.get('/v1/organization');
    expect(org.body.slug).toMatch(/^org-[0-9a-f]{10}$/);
    expect(org.body.settings.ownerProfile).toMatchObject({ ownerType: 'company', companyName: '株式会社サンプル', companyEmail: 'info@example.com' });
    const shops = await owner.get('/v1/shops');
    expect(shops.body).toHaveLength(1);
    expect(shops.body[0]).toMatchObject({ name: 'ビューティーサロン 渋谷店', phone: '03-0000-0000', postal_code: '150-0001', address_line: '東京都渋谷区1-2-3', email: 'shop@example.com' });
    expect(shops.body[0].slug).toMatch(/^shop-[0-9a-f]{10}$/);
  });
});

describe('設定 › オーナー情報', () => {
  it('saves the owner profile for the owner only and keeps other organization settings', async () => {
    const t = await createTenant();
    await t.owner.patch('/v1/organization', { settings: { somethingElse: 1 } });
    const saved = await t.owner.patch('/v1/organization', { ownerProfile: { ownerType: 'company', companyName: '株式会社テスト', companyPostalCode: '123-4567', companyPhone: null, companyAddress: '東京都', companyEmail: 'info@example.com' } });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.ownerProfile.companyName).toBe('株式会社テスト');
    expect(saved.body.settings.somethingElse).toBe(1);
    // switching to 個人 clears the company details the screen sends as null
    const individual = await t.owner.patch('/v1/organization', { ownerProfile: { ownerType: 'individual', companyName: null, companyPostalCode: null, companyPhone: null, companyAddress: null, companyEmail: null } });
    expect(individual.body.settings.ownerProfile).toEqual({ ownerType: 'individual', companyName: null, companyPostalCode: null, companyPhone: null, companyAddress: null, companyEmail: null });
    expect((await t.owner.get('/v1/organization')).body.settings.ownerProfile.ownerType).toBe('individual');

    const bad = await t.owner.patch('/v1/organization', { ownerProfile: { ownerType: 'partnership' } });
    expect(bad.status).toBe(400);
    const manager = await createStaffUser(t, 'manager');
    const denied = await manager.api.patch('/v1/organization', { ownerProfile: { ownerType: 'individual' } });
    expect(denied.status).toBe(403);
  });
});

describe('設定 › 店舗一覧', () => {
  it('creates a shop from name / address / phone / email alone', async () => {
    const t = await createTenant();
    const created = await t.owner.post('/v1/shops', { name: 'ビューティーサロン 新宿店', addressLine: '東京都新宿区1-1', phone: '03-1234-5678', email: 'store@example.com' });
    expect(created.status).toBe(201);
    expect(created.body.slug).toMatch(/^shop-[0-9a-f]{10}$/);
    expect(created.body).toMatchObject({ name: 'ビューティーサロン 新宿店', address_line: '東京都新宿区1-1', phone: '03-1234-5678', email: 'store@example.com' });
    expect((await t.owner.get('/v1/shops')).body).toHaveLength(2);
    // default business hours are seeded like the first shop
    const hours = await t.owner.get(`/v1/shops/${created.body.id}/business-hours`);
    expect(hours.status).toBe(200);
    expect(hours.body.length).toBeGreaterThan(0);
  });

  it('removes a shop: not the last one, not with bookings ahead, owner only', async () => {
    const t = await createTenant();
    const last = await t.owner.delete(`/v1/shops/${t.shopId}`);
    expect(last.status).toBe(422);
    expect(last.body.error.code).toBe('LAST_SHOP');

    const second = (await t.owner.post('/v1/shops', { name: '2号店' })).body;
    const stylist = await createStaffUser(t, 'stylist', { shopIds: [second.id, t.shopId] });
    const manager = await createStaffUser(t, 'manager', { shopIds: [second.id] });
    expect((await manager.api.delete(`/v1/shops/${second.id}`)).status).toBe(403);

    // a booking ahead blocks the removal
    const menu = await createMenu(t);
    const customer = await createCustomer(t);
    const date = nextWeekday(WED);
    const appt = await t.owner.post('/v1/appointments', { shopId: second.id, customerId: customer.id, staffId: stylist.staffId, startAt: jst(date, '12:00'), menuIds: [menu.id] });
    expect(appt.status).toBe(201);
    const blocked = await t.owner.delete(`/v1/shops/${second.id}`);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('SHOP_HAS_UPCOMING_APPOINTMENTS');
    expect(blocked.body.error.details.upcoming).toBe(1);
    await t.owner.post(`/v1/appointments/${appt.body.id}/cancel`, { reason: 'テスト' });

    const before = (await t.owner.get(`/v1/staff/${stylist.staffId}`)).body;
    expect(before.shops.find((s: { shop_id: string }) => s.shop_id === second.id).is_primary).toBe(true);

    const removed = await t.owner.delete(`/v1/shops/${second.id}`);
    expect(removed.status).toBe(204);
    const shops = await t.owner.get('/v1/shops');
    expect(shops.body.map((s: { id: string }) => s.id)).toEqual([t.shopId]);
    expect((await t.owner.get(`/v1/shops/${second.id}`)).status).toBe(404);
    // staff lose the assignment; the remaining shop becomes their main shop
    const after = (await t.owner.get(`/v1/staff/${stylist.staffId}`)).body;
    expect(after.shops).toHaveLength(1);
    expect(after.shops[0]).toMatchObject({ shop_id: t.shopId, is_primary: true });
    // the cancelled booking is still on record
    expect((await t.owner.get(`/v1/appointments/${appt.body.id}`)).body.status).toBe('cancelled');
  });

  it('does not let another organization remove a shop', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const extra = (await a.owner.post('/v1/shops', { name: '別店舗' })).body;
    const res = await b.owner.delete(`/v1/shops/${extra.id}`);
    expect(res.status).toBe(404);
    expect((await a.owner.get('/v1/shops')).body).toHaveLength(2);
  });
});

describe('設定 › スタッフ管理 › 店舗割り当て', () => {
  it('assigns shops with a main shop and keeps one main shop when it is removed', async () => {
    const t = await createTenant();
    const second = (await t.owner.post('/v1/shops', { name: '2号店' })).body;
    const third = (await t.owner.post('/v1/shops', { name: '3号店' })).body;
    const stylist = await createStaffUser(t, 'stylist');
    const shopsOf = (body: { shops: { shop_id: string; is_primary: boolean }[] }) => Object.fromEntries(body.shops.map((s) => [s.shop_id, s.is_primary]));

    const added = await t.owner.put(`/v1/staff/${stylist.staffId}/shops`, { shopIds: [t.shopId, second.id, third.id], primaryShopId: t.shopId });
    expect(added.status).toBe(200);
    expect(shopsOf(added.body)).toEqual({ [t.shopId]: true, [second.id]: false, [third.id]: false });

    const moved = await t.owner.put(`/v1/staff/${stylist.staffId}/shops`, { shopIds: [second.id, third.id], primaryShopId: third.id });
    expect(shopsOf(moved.body)).toEqual({ [second.id]: false, [third.id]: true });

    // main shop unticked without naming a new one → another assignment takes over
    const dropped = await t.owner.put(`/v1/staff/${stylist.staffId}/shops`, { shopIds: [second.id] });
    expect(shopsOf(dropped.body)).toEqual({ [second.id]: true });

    // ticking a shop again after unticking it the same day works
    const again = await t.owner.put(`/v1/staff/${stylist.staffId}/shops`, { shopIds: [second.id, third.id] });
    expect(shopsOf(again.body)).toEqual({ [second.id]: true, [third.id]: false });

    const invalid = await t.owner.put(`/v1/staff/${stylist.staffId}/shops`, { shopIds: [second.id], primaryShopId: third.id });
    expect(invalid.status).toBe(400);
    expect((await stylist.api.put(`/v1/staff/${stylist.staffId}/shops`, { shopIds: [t.shopId] })).status).toBe(403);
    // a shop of another organization cannot be ticked
    const other = await createTenant();
    const foreign = await t.owner.put(`/v1/staff/${stylist.staffId}/shops`, { shopIds: [second.id, other.shopId] });
    expect(foreign.status).toBe(404);
  });

  it('hides a staff member from the customer booking page of one shop', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist', { displayName: '非表示スタイリスト' });
    const menu = await createMenu(t);
    const slug = (await t.owner.get(`/v1/shops/${t.shopId}`)).body.slug;
    const names = async () => ((await api().get(`/v1/public/shops/${slug}`)).body.staff as { display_name: string }[]).map((s) => s.display_name);
    expect(await names()).toContain('非表示スタイリスト');

    const listed = (await t.owner.get('/v1/staff')).body.find((s: { id: string }) => s.id === stylist.staffId);
    expect(listed.shops[0].is_visible_to_customer).toBe(true);

    const hidden = await t.owner.put(`/v1/staff/${stylist.staffId}/shops/${t.shopId}/visibility`, { visible: false });
    expect(hidden.status).toBe(200);
    expect(hidden.body.shops[0].is_visible_to_customer).toBe(false);
    expect(await names()).not.toContain('非表示スタイリスト');

    // customers cannot nominate a hidden staff member; staff can still book them
    const date = nextWeekday(WED);
    const online = await api().post(`/v1/public/shops/${slug}/appointments`, {
      menuIds: [menu.id],
      staffId: stylist.staffId,
      startAt: jst(date, '12:00'),
      customer: { lastName: '予約', firstName: '花子', phone: '090-5555-6666' },
    });
    expect(online.status).toBe(400);
    const byStaff = await t.owner.post('/v1/appointments', { shopId: t.shopId, staffId: stylist.staffId, startAt: jst(date, '12:00'), menuIds: [menu.id] });
    expect(byStaff.status).toBe(201);

    const shown = await t.owner.put(`/v1/staff/${stylist.staffId}/shops/${t.shopId}/visibility`, { visible: true });
    expect(shown.body.shops[0].is_visible_to_customer).toBe(true);
    expect(await names()).toContain('非表示スタイリスト');

    // not assigned to that shop → nothing to toggle
    const other = (await t.owner.post('/v1/shops', { name: '2号店' })).body;
    const notAssigned = await t.owner.put(`/v1/staff/${stylist.staffId}/shops/${other.id}/visibility`, { visible: false });
    expect(notAssigned.status).toBe(422);
    expect(notAssigned.body.error.code).toBe('NOT_ASSIGNED');
    expect((await stylist.api.put(`/v1/staff/${stylist.staffId}/shops/${t.shopId}/visibility`, { visible: false })).status).toBe(403);
  });
});

describe('設定 › スタッフ管理 › スタッフ招待 / 招待履歴', () => {
  it('invites by e-mail, lists the invitation as pending and then accepted', async () => {
    const t = await createTenant();
    const email = `invitee-${randomUUID().slice(0, 8)}@example.com`;
    const before = mockOutbox.length;
    const invited = await t.owner.post('/v1/staff-invitations', { email, displayName: '招待 花子', roleKey: 'manager', shopId: t.shopId });
    expect(invited.status).toBe(201);
    expect(invited.body.emailSent).toBe(true);
    expect(invited.body.inviteUrl).toContain('/invite/');
    const mail = mockOutbox.slice(before).find((m) => m.to === email);
    expect(mail?.text).toContain(invited.body.inviteUrl);
    expect(mail?.text).toContain('テストサロン 本店');

    const staff = (await t.owner.get(`/v1/staff/${invited.body.staffId}`)).body;
    expect(staff).toMatchObject({ display_name: '招待 花子', status: 'invited' });
    expect(staff.role.key).toBe('manager');
    expect(staff.shops.map((s: { shop_id: string }) => s.shop_id)).toEqual([t.shopId]);

    const pending = (await t.owner.get('/v1/staff-invitations')).body;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ staff_name: '招待 花子', email, shop_name: 'テストサロン 本店', role_key: 'manager', invited_by_name: 'オーナー 太郎', status: 'pending' });

    // the same person cannot be invited twice
    const dup = await t.owner.post('/v1/staff-invitations', { email: email.toUpperCase(), displayName: '別名', roleKey: 'stylist', shopId: t.shopId });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('STAFF_EXISTS');

    const token = (invited.body.inviteUrl as string).split('/invite/')[1];
    const accepted = await api().post('/v1/auth/accept-invite', { token, password: 'new-password-1234' });
    expect(accepted.status).toBe(200);
    const after = (await t.owner.get('/v1/staff-invitations')).body;
    expect(after[0].status).toBe('accepted');
    expect(after[0].accepted_at).toBeTruthy();
  });

  it('shows an invitation as cancelled when the invited staff was retired before accepting', async () => {
    const t = await createTenant();
    const email = `invitee-${randomUUID().slice(0, 8)}@example.com`;
    const invited = await t.owner.post('/v1/staff-invitations', { email, displayName: '取消 太郎', roleKey: 'stylist', shopId: t.shopId });
    await t.owner.patch(`/v1/staff/${invited.body.staffId}`, { status: 'retired' });
    expect((await t.owner.get('/v1/staff-invitations')).body[0].status).toBe('cancelled');
  });

  it('is limited to staff managers and to the own organization', async () => {
    const t = await createTenant();
    const other = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    const email = `invitee-${randomUUID().slice(0, 8)}@example.com`;
    expect((await stylist.api.post('/v1/staff-invitations', { email, displayName: 'X', roleKey: 'stylist', shopId: t.shopId })).status).toBe(403);
    expect((await stylist.api.get('/v1/staff-invitations')).status).toBe(403);
    // a shop of another organization
    expect((await other.owner.post('/v1/staff-invitations', { email, displayName: 'X', roleKey: 'stylist', shopId: t.shopId })).status).toBe(404);
    expect((await t.owner.post('/v1/staff-invitations', { email: 'not-an-email', displayName: 'X', roleKey: 'stylist', shopId: t.shopId })).status).toBe(400);
    expect((await t.owner.post('/v1/staff-invitations', { email, displayName: 'X', roleKey: 'owner', shopId: t.shopId })).status).toBe(400);
    await t.owner.post('/v1/staff-invitations', { email, displayName: '招待', roleKey: 'stylist', shopId: t.shopId });
    expect((await t.owner.get('/v1/staff-invitations')).body).toHaveLength(1);
    expect((await other.owner.get('/v1/staff-invitations')).body).toHaveLength(0);
  });
});
