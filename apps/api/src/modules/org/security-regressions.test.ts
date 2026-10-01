import { describe, expect, it } from 'vitest';
import { api, createMenu, createStaffUser, createTenant, jst, nextWeekday } from '../../test/helpers.js';

describe('security regressions', () => {
  it('PATCH memo without visibility keeps a private memo private', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    const c = (await t.owner.post('/v1/customers', { lastName: 'メモ' })).body.customer;
    const memo = (await stylist.api.post(`/v1/customers/${c.id}/memos`, { body: '秘密', visibility: 'private' })).body;
    const pinned = await stylist.api.patch(`/v1/customer-memos/${memo.id}`, { pinned: true });
    expect(pinned.body.visibility).toBe('private');
    const ownerView = await t.owner.get(`/v1/customers/${c.id}/memos`);
    expect(ownerView.body).toHaveLength(0);
  });

  it('renaming a role does not wipe its permissions', async () => {
    const t = await createTenant();
    const role = (await t.owner.post('/v1/roles', { key: 'front', name: 'フロント', permissions: ['customer.read', 'appointment.read'] })).body;
    const renamed = await t.owner.patch(`/v1/roles/${role.id}`, { name: 'フロント受付' });
    expect(renamed.body.name).toBe('フロント受付');
    expect(renamed.body.permissions.sort()).toEqual(['appointment.read', 'customer.read']);
  });

  it('invite links are single-use and cannot act as a login', async () => {
    const t = await createTenant();
    const roles = (await t.owner.get('/v1/roles')).body as { id: string; key: string }[];
    const created = await t.owner.post('/v1/staff', {
      displayName: '招待スタッフ',
      email: `invitee-${Date.now()}@example.com`,
      roleId: roles.find((r) => r.key === 'stylist')!.id,
      shopIds: [t.shopId],
    });
    expect(created.body.staff.status).toBe('invited');
    const token = created.body.inviteUrl.split('/').pop();
    const first = await api().post('/v1/auth/accept-invite', { token, password: 'new-password-123' });
    expect(first.status).toBe(200);
    const replay = await api().post('/v1/auth/accept-invite', { token, password: 'anything-else-1' });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('INVALID_INVITE');
  });

  it('existing users invited to another organization must prove their password', async () => {
    const a = await createTenant('A');
    const b = await createTenant('B');
    const roles = (await b.owner.get('/v1/roles')).body as { id: string; key: string }[];
    const created = await b.owner.post('/v1/staff', { displayName: 'A社オーナー', email: a.email, roleId: roles.find((r) => r.key === 'stylist')!.id, shopIds: [b.shopId] });
    const token = created.body.inviteUrl.split('/').pop();
    const wrong = await api().post('/v1/auth/accept-invite', { token, password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    const ok = await api().post('/v1/auth/accept-invite', { token, password: a.password });
    expect(ok.status).toBe(200);
    expect(ok.body.organizationId).toBe(b.organizationId);
  });

  it('guest bookings do not attach to an existing customer by phone alone', async () => {
    const t = await createTenant();
    const menu = await createMenu(t);
    const slug = (await t.owner.get(`/v1/shops/${t.shopId}`)).body.slug;
    const existing = (await t.owner.post('/v1/customers', { lastName: '本人', firstName: '花子', phone: '09033334444' })).body.customer;
    const date = nextWeekday(3);
    const other = await api().post(`/v1/public/shops/${slug}/appointments`, {
      menuIds: [menu.id],
      startAt: jst(date, '11:00'),
      customer: { lastName: '他人', firstName: '太郎', phone: '090-3333-4444' },
    });
    expect(other.status).toBe(201);
    const appt = (await t.owner.get(`/v1/appointments/${other.body.appointment.id}`)).body;
    expect(appt.customer_id).not.toBe(existing.id);
    const same = await api().post(`/v1/public/shops/${slug}/appointments`, {
      menuIds: [menu.id],
      startAt: jst(date, '14:00'),
      customer: { lastName: '本人', firstName: '花子', phone: '090-3333-4444' },
    });
    expect((await t.owner.get(`/v1/appointments/${same.body.appointment.id}`)).body.customer_id).toBe(existing.id);
  });
});
