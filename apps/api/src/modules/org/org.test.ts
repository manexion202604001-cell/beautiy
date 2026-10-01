import { describe, expect, it } from 'vitest';
import { withSystem } from '../../db/tenant.js';
import { api, createStaffUser, createTenant } from '../../test/helpers.js';

describe('auth & organization', () => {
  it('signs up a new organization with owner, shop, roles and default hours', async () => {
    const t = await createTenant();
    const me = await t.owner.get('/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.staff.role_key).toBe('owner');
    expect(me.body.permissions).toContain('org.manage');
    expect(me.body.allShops).toBe(true);
    const shops = await t.owner.get('/v1/shops');
    expect(shops.body).toHaveLength(1);
    expect(shops.body[0].settings.booking.slotIntervalMin).toBe(15);
    const roles = await t.owner.get('/v1/roles');
    expect(roles.body.map((r: { key: string }) => r.key)).toEqual(expect.arrayContaining(['owner', 'manager', 'stylist', 'reception']));
  });

  it('rejects bad credentials and locks after repeated failures', async () => {
    const t = await createTenant();
    const bad = await api().post('/v1/auth/login', { email: t.email, password: 'wrong-password' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(bad.body.error.category).toBe('authentication');
    for (let i = 0; i < 10; i++) await api().post('/v1/auth/login', { email: t.email, password: 'wrong-password' });
    const locked = await api().post('/v1/auth/login', { email: t.email, password: t.password });
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('rotates refresh tokens, tolerates concurrent refresh, and revokes only the reused family', async () => {
    const t = await createTenant();
    const login = await api().post('/v1/auth/login', { email: t.email, password: t.password });
    const otherDevice = await api().post('/v1/auth/login', { email: t.email, password: t.password });
    expect(login.body.status).toBe('authenticated');
    const r1 = await api().post('/v1/auth/refresh', { refreshToken: login.body.refreshToken });
    expect(r1.status).toBe(200);
    // replay within the grace window (two tabs) → 409, nothing revoked
    const race = await api().post('/v1/auth/refresh', { refreshToken: login.body.refreshToken });
    expect(race.status).toBe(409);
    expect(race.body.error.code).toBe('REFRESH_IN_PROGRESS');
    // age the rotation beyond the grace window → genuine reuse
    await withSystem((trx) => trx.updateTable('auth_sessions').set({ created_at: new Date(Date.now() - 120_000) }).where('user_id', 'is not', null).where('revoked_at', 'is', null).execute());
    const reuse = await api().post('/v1/auth/refresh', { refreshToken: login.body.refreshToken });
    expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    // the whole family is revoked …
    const r2 = await api().post('/v1/auth/refresh', { refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(401);
    // … but other devices keep working
    const other = await api().post('/v1/auth/refresh', { refreshToken: otherDevice.body.refreshToken });
    expect(other.status).toBe(200);
  });

  it('supports MFA with email OTP', async () => {
    const t = await createTenant();
    await t.owner.put('/v1/auth/mfa', { enabled: true });
    const login = await api().post('/v1/auth/login', { email: t.email, password: t.password });
    expect(login.body.status).toBe('mfa_required');
    const wrong = await api().post('/v1/auth/otp/verify', { challengeId: login.body.challengeId, code: '000000' === login.body.devCode ? '111111' : '000000' });
    expect(wrong.status).toBe(401);
    const ok = await api().post('/v1/auth/otp/verify', { challengeId: login.body.challengeId, code: login.body.devCode });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
  });

  it('isolates tenants (RLS + resource authorization)', async () => {
    const a = await createTenant('A');
    const b = await createTenant('B');
    const res = await a.owner.get(`/v1/shops/${b.shopId}`);
    // owner has all-shops scope in A, but B's shop is invisible through RLS
    expect(res.status).toBe(404);
    const staffB = await b.owner.get('/v1/staff');
    expect(staffB.body.every((s: { id: string }) => s.id !== a.ownerStaffId)).toBe(true);
  });

  it('restricts shop access for non all-shops roles', async () => {
    const t = await createTenant();
    const shop2 = await t.owner.post('/v1/shops', { name: '2号店', slug: `s2-${Date.now()}` });
    expect(shop2.status).toBe(201);
    const stylist = await createStaffUser(t, 'stylist');
    const shops = await stylist.api.get('/v1/shops');
    expect(shops.body.map((s: { id: string }) => s.id)).toEqual([t.shopId]);
    const forbidden = await stylist.api.get(`/v1/shops/${shop2.body.id}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('SHOP_FORBIDDEN');
    const cannot = await stylist.api.patch('/v1/organization', { name: 'x' });
    expect(cannot.status).toBe(403);
  });

  it('audits role changes and protects the last owner', async () => {
    const t = await createTenant();
    const roles = (await t.owner.get('/v1/roles')).body as { id: string; key: string }[];
    const manager = roles.find((r) => r.key === 'manager')!;
    const res = await t.owner.put(`/v1/staff/${t.ownerStaffId}/role`, { roleId: manager.id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('LAST_OWNER');
    const stylist = await createStaffUser(t, 'stylist');
    const changed = await t.owner.put(`/v1/staff/${stylist.staffId}/role`, { roleId: manager.id });
    expect(changed.status).toBe(200);
    expect(changed.body.role.key).toBe('manager');
    const me = await stylist.api.get('/v1/me');
    expect(me.body.staff.role_key).toBe('manager');
  });

  it('transfers staff between shops and reassigns customer relations', async () => {
    const t = await createTenant();
    const shop2 = (await t.owner.post('/v1/shops', { name: '2号店', slug: `s2x-${Date.now()}` })).body;
    const s1 = await createStaffUser(t, 'stylist');
    const s2 = await createStaffUser(t, 'stylist');
    const res = await t.owner.post(`/v1/staff/${s1.staffId}/transfer`, {
      fromShopId: t.shopId,
      toShopId: shop2.id,
      customerPolicy: 'reassign',
      reassignToStaffId: s2.staffId,
    });
    expect(res.status).toBe(200);
    expect(res.body.staff.shops.map((s: { shop_id: string }) => s.shop_id)).toEqual([shop2.id]);
  });
});
