import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { api, createStaffUser, createTenant, type Tenant } from '../../test/helpers.js';

type Row = Record<string, any>;

async function roleId(t: Tenant, key: string): Promise<string> {
  const roles = (await t.owner.get('/v1/roles')).body as { id: string; key: string }[];
  return roles.find((r) => r.key === key)!.id;
}

async function secondShop(t: Tenant, name = '2号店'): Promise<string> {
  const res = await t.owner.post('/v1/shops', { name, slug: `shop-${randomUUID().slice(0, 8)}` });
  expect(res.status).toBe(201);
  return res.body.id;
}

const codeOf = async (t: Tenant, staffId: string) =>
  (await t.owner.get(`/v1/staff/${staffId}`)).body.staff_code as string;

describe('6桁のスタッフID (staff_code)', () => {
  it('every staff member gets a unique 6-digit ID, shown on the staff list and on /me', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const created: string[] = [];
    for (const t of [a, b]) {
      for (let i = 0; i < 3; i++) {
        const s = (
          await t.owner.post('/v1/staff', {
            displayName: `スタッフ${i}`,
            roleId: await roleId(t, 'stylist'),
            shopIds: [t.shopId],
          })
        ).body.staff;
        created.push(s.staff_code);
      }
      created.push(await codeOf(t, t.ownerStaffId));
    }
    for (const code of created) expect(code).toMatch(/^\d{6}$/);
    expect(new Set(created).size).toBe(created.length);

    const me = (await a.owner.get('/v1/me')).body;
    expect(me.staff.staff_code).toBe(await codeOf(a, a.ownerStaffId));
    expect(me.user.must_change_password).toBe(false);
    expect(me.primaryShopId).toBe(a.shopId);
    const listed = (await a.owner.get('/v1/staff')).body as Row[];
    expect(listed.every((s) => /^\d{6}$/.test(s.staff_code))).toBe(true);
  });

  it('search returns only name / photo / ID, and says whether the person belongs to this salon', async () => {
    const t = await createTenant();
    const other = await createTenant('別サロン');
    const stylist = await createStaffUser(t, 'stylist', { displayName: '同じ 花子' });
    const stranger = await createStaffUser(other, 'stylist', { displayName: '別の 太郎' });

    const mine = await t.owner.get(`/v1/staff/search/code/${await codeOf(t, stylist.staffId)}`);
    expect(mine.status).toBe(200);
    expect(mine.body.staff).toMatchObject({
      name: '同じ 花子',
      same_organization: true,
      id: stylist.staffId,
      role_key: 'stylist',
      shop_ids: [t.shopId],
      avatar_url: null,
    });

    const theirs = await t.owner.get(
      `/v1/staff/search/code/${await codeOf(other, stranger.staffId)}`,
    );
    expect(theirs.status).toBe(200);
    expect(Object.keys(theirs.body.staff).sort()).toEqual([
      'avatar_url',
      'name',
      'same_organization',
      'staff_code',
    ]);
    expect(theirs.body.staff).toMatchObject({ name: '別の 太郎', same_organization: false });

    // codes below 100000 are never issued
    const missing = await t.owner.get('/v1/staff/search/code/099999');
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toBe('スタッフが見つかりません');
    expect((await t.owner.get('/v1/staff/search/code/12345')).status).toBe(400);
    expect((await t.owner.get('/v1/staff/search/code/abcdef')).status).toBe(400);
    // staff without スタッフ管理 cannot look people up
    expect(
      (await stylist.api.get(`/v1/staff/search/code/${await codeOf(t, t.ownerStaffId)}`)).status,
    ).toBe(403);
  });

  it('link by ID adds a staff member of this salon to the shop and records 承認済 in 招待履歴', async () => {
    const t = await createTenant();
    const shop2 = await secondShop(t);
    const stylist = await createStaffUser(t, 'stylist', { displayName: '移動 花子' });
    const code = await codeOf(t, stylist.staffId);

    const linked = await t.owner.post('/v1/staff/link-by-code', {
      staffCode: code,
      shopId: shop2,
      roleKey: 'stylist',
    });
    expect(linked.status).toBe(201);
    expect(linked.body).toMatchObject({ staffId: stylist.staffId, status: 'accepted' });
    const staff = (await t.owner.get(`/v1/staff/${stylist.staffId}`)).body;
    expect(staff.shops.map((s: Row) => s.shop_id).sort()).toEqual([t.shopId, shop2].sort());
    expect(staff.shops.find((s: Row) => s.is_primary).shop_id).toBe(t.shopId);
    // the staff member can open the new shop
    expect((await stylist.api.get(`/v1/shops/${shop2}`)).status).toBe(200);

    const history = (await t.owner.get('/v1/staff-invitations')).body as Row[];
    expect(history[0]).toMatchObject({
      staff_id: stylist.staffId,
      shop_id: shop2,
      staff_code: code,
      status: 'accepted',
      invited_by_name: 'オーナー 太郎',
      role_key: 'stylist',
    });

    const again = await t.owner.post('/v1/staff/link-by-code', { staffCode: code, shopId: shop2 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_ASSIGNED');

    // 権限 ディレクター promotes the staff member (the owner may change roles)
    const shop3 = await secondShop(t, '3号店');
    expect(
      (
        await t.owner.post('/v1/staff/link-by-code', {
          staffCode: code,
          shopId: shop3,
          roleKey: 'manager',
        })
      ).status,
    ).toBe(201);
    expect((await t.owner.get(`/v1/staff/${stylist.staffId}`)).body.role.key).toBe('manager');
  });

  it('refuses a code of another salon, retired staff, role changes by a manager and staff without the right', async () => {
    const t = await createTenant();
    const other = await createTenant('別サロン');
    const stranger = await createStaffUser(other, 'stylist');
    const cross = await t.owner.post('/v1/staff/link-by-code', {
      staffCode: await codeOf(other, stranger.staffId),
      shopId: t.shopId,
    });
    expect(cross.status).toBe(422);
    expect(cross.body.error.code).toBe('STAFF_IN_OTHER_ORGANIZATION');
    expect(cross.body.error.message).toContain('メールアドレスで招待');
    // nothing moved between the salons
    expect((await other.owner.get(`/v1/staff/${stranger.staffId}`)).body.shops).toHaveLength(1);
    expect((await t.owner.get('/v1/staff-invitations')).body).toHaveLength(0);

    const shop2 = await secondShop(t);
    const retired = (
      await t.owner.post('/v1/staff', {
        displayName: '退職 一郎',
        roleId: await roleId(t, 'stylist'),
        shopIds: [t.shopId],
      })
    ).body.staff;
    await t.owner.patch(`/v1/staff/${retired.id}`, { status: 'retired' });
    const r = await t.owner.post('/v1/staff/link-by-code', {
      staffCode: retired.staff_code,
      shopId: shop2,
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('STAFF_NOT_WORKING');

    const manager = await createStaffUser(t, 'manager', { shopIds: [t.shopId, shop2] });
    const stylist = await createStaffUser(t, 'stylist');
    const code = await codeOf(t, stylist.staffId);
    expect(
      (
        await manager.api.post('/v1/staff/link-by-code', {
          staffCode: code,
          shopId: shop2,
          roleKey: 'manager',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await manager.api.post('/v1/staff/link-by-code', {
          staffCode: code,
          shopId: shop2,
          roleKey: 'stylist',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await stylist.api.post('/v1/staff/link-by-code', {
          staffCode: await codeOf(t, manager.staffId),
          shopId: t.shopId,
        })
      ).status,
    ).toBe(403);
    // an owner keeps the owner role whatever 権限 says (a shop the manager created has no owner assignment)
    const shop3 = await manager.api.post('/v1/shops', {
      name: '3号店',
      slug: `shop-${randomUUID().slice(0, 8)}`,
    });
    expect(shop3.status).toBe(201);
    expect(
      (
        await t.owner.post('/v1/staff/link-by-code', {
          staffCode: await codeOf(t, t.ownerStaffId),
          shopId: shop3.body.id,
          roleKey: 'stylist',
        })
      ).status,
    ).toBe(201);
    expect((await t.owner.get(`/v1/staff/${t.ownerStaffId}`)).body.role.key).toBe('owner');
  });
});

describe('招待の辞退', () => {
  it('the invitee declines: 辞退 in 招待履歴, the link stops working, the address can be invited again', async () => {
    const t = await createTenant();
    const email = `invitee-${randomUUID().slice(0, 8)}@example.com`;
    const invited = await t.owner.post('/v1/staff-invitations', {
      email,
      displayName: '辞退 花子',
      roleKey: 'stylist',
      shopId: t.shopId,
    });
    expect(invited.status).toBe(201);
    const token = (invited.body.inviteUrl as string).split('/invite/')[1]!;

    expect((await api().post('/v1/auth/decline-invite', { token })).status).toBe(204);
    const history = (await t.owner.get('/v1/staff-invitations')).body as Row[];
    expect(history[0]).toMatchObject({ status: 'declined', staff_name: '辞退 花子' });
    expect(history[0].declined_at).toBeTruthy();
    expect(
      ((await t.owner.get('/v1/staff', { includeInactive: true })).body as Row[]).some(
        (s) => s.id === invited.body.staffId,
      ),
    ).toBe(false);

    expect((await api().post('/v1/auth/decline-invite', { token })).status).toBe(401);
    expect(
      (await api().post('/v1/auth/accept-invite', { token, password: 'new-password-1234' })).status,
    ).toBe(401);
    expect(
      (await api().post('/v1/auth/decline-invite', { token: 'not-a-valid-token' })).status,
    ).toBe(401);

    const again = await t.owner.post('/v1/staff-invitations', {
      email,
      displayName: '辞退 花子',
      roleKey: 'stylist',
      shopId: t.shopId,
    });
    expect(again.status).toBe(201);
    const statuses = ((await t.owner.get('/v1/staff-invitations')).body as Row[]).map(
      (i) => i.status,
    );
    expect(statuses).toEqual(['pending', 'declined']);
  });
});

describe('初回ログイン時のパスワード変更 (ログイン情報を設定)', () => {
  it('a temporary password must be replaced before anything else works', async () => {
    const t = await createTenant();
    const staff = (
      await t.owner.post('/v1/staff', {
        displayName: '新人 花子',
        roleId: await roleId(t, 'stylist'),
        shopIds: [t.shopId],
      })
    ).body.staff;
    const email = `new-${randomUUID().slice(0, 8)}@example.com`;
    const set = await t.owner.put(`/v1/staff/${staff.id}/credentials`, {
      email,
      password: 'temp-pass',
      temporary: true,
    });
    expect(set.status).toBe(200);

    const login = await api().post('/v1/auth/login', { email, password: 'temp-pass' });
    expect(login.body.status).toBe('authenticated');
    const client = api(login.body.accessToken);
    const me = await client.get('/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.user.must_change_password).toBe(true);
    const blocked = await client.get('/v1/shops');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    expect(
      (
        await client.post('/v1/auth/password', {
          currentPassword: 'temp-pass',
          newPassword: 'temp-pass',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await client.post('/v1/auth/password', {
          currentPassword: 'temp-pass',
          newPassword: 'short',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await client.post('/v1/auth/password', {
          currentPassword: 'temp-pass',
          newPassword: 'my-own-pass',
        })
      ).status,
    ).toBe(204);

    const relogin = await api().post('/v1/auth/login', { email, password: 'my-own-pass' });
    const fresh = api(relogin.body.accessToken);
    expect((await fresh.get('/v1/me')).body.user.must_change_password).toBe(false);
    expect((await fresh.get('/v1/shops')).status).toBe(200);
  });

  it('a password set from スタッフ編集 (not temporary) or by the staff member themself is final', async () => {
    const t = await createTenant();
    const staff = (
      await t.owner.post('/v1/staff', {
        displayName: '編集 太郎',
        roleId: await roleId(t, 'stylist'),
        shopIds: [t.shopId],
      })
    ).body.staff;
    const email = `edit-${randomUUID().slice(0, 8)}@example.com`;
    expect(
      (await t.owner.put(`/v1/staff/${staff.id}/credentials`, { email, password: 'final-pass' }))
        .status,
    ).toBe(200);
    const login = await api().post('/v1/auth/login', { email, password: 'final-pass' });
    expect((await api(login.body.accessToken).get('/v1/shops')).status).toBe(200);

    // the owner's own login: never flagged
    expect(
      (
        await t.owner.put(`/v1/staff/${t.ownerStaffId}/credentials`, {
          email: t.email,
          password: 'owner-pass',
          temporary: true,
        })
      ).status,
    ).toBe(200);
    const owner = await api().post('/v1/auth/login', { email: t.email, password: 'owner-pass' });
    expect((await api(owner.body.accessToken).get('/v1/me')).body.user.must_change_password).toBe(
      false,
    );
  });
});

describe('パスワードは8文字以上', () => {
  it('applies to sign-up, temporary passwords, invitations and resets', async () => {
    const suffix = randomUUID().slice(0, 8);
    const base = {
      organizationName: '8文字サロン',
      shopName: '本店',
      ownerName: 'オーナー',
      email: `pw-${suffix}@example.com`,
    };
    const short = await api().post('/v1/auth/signup', { ...base, password: '1234567' });
    expect(short.status).toBe(400);
    expect(JSON.stringify(short.body)).toContain('パスワードは8文字以上にしてください');
    expect((await api().post('/v1/auth/signup', { ...base, password: '12345678' })).status).toBe(
      201,
    );

    const t = await createTenant();
    const staff = (
      await t.owner.post('/v1/staff', {
        displayName: 'X',
        roleId: await roleId(t, 'stylist'),
        shopIds: [t.shopId],
      })
    ).body.staff;
    const email = `cred-${suffix}@example.com`;
    expect(
      (await t.owner.put(`/v1/staff/${staff.id}/credentials`, { email, password: '1234567' }))
        .status,
    ).toBe(400);
    expect(
      (await t.owner.put(`/v1/staff/${staff.id}/credentials`, { email, password: '12345678' }))
        .status,
    ).toBe(200);

    const invited = await t.owner.post('/v1/staff-invitations', {
      email: `inv-${suffix}@example.com`,
      displayName: 'Y',
      roleKey: 'stylist',
      shopId: t.shopId,
    });
    const token = (invited.body.inviteUrl as string).split('/invite/')[1]!;
    expect(
      (await api().post('/v1/auth/accept-invite', { token, password: '1234567' })).status,
    ).toBe(400);
    expect(
      (await api().post('/v1/auth/accept-invite', { token, password: '12345678' })).status,
    ).toBe(200);
    expect(
      (
        await api().post('/v1/auth/password-reset/confirm', {
          token: 'x'.repeat(20),
          password: '1234567',
        })
      ).status,
    ).toBe(400);
  });
});
