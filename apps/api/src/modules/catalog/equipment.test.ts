import { describe, expect, it } from 'vitest';
import { createMenu, createStaffUser, createTenant, jst, nextWeekday } from '../../test/helpers.js';

const WED = 3;

describe('設備 (店舗設定 › 設備)', () => {
  it('adds, lists, edits and removes equipment as name + quantity', async () => {
    const t = await createTenant();
    const created = await t.owner.post('/v1/equipment', { shopId: t.shopId, name: ' シャンプー台 ', quantity: 2 });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ shopId: t.shopId, name: 'シャンプー台', quantity: 2, isActive: true });
    await t.owner.post('/v1/equipment', { shopId: t.shopId, name: '個室', quantity: 1 });
    expect((await t.owner.post('/v1/equipment', { shopId: t.shopId, name: 'シャンプー台', quantity: 1 })).status).toBe(409);

    // each unit is a row of the existing resources table
    const units = (await t.owner.get('/v1/resources', { shopId: t.shopId })).body as { name: string; resource_type: string }[];
    expect(units.filter((u) => u.resource_type === 'シャンプー台').map((u) => u.name)).toEqual(['シャンプー台 1', 'シャンプー台 2']);

    const more = await t.owner.patch('/v1/equipment', { shopId: t.shopId, name: 'シャンプー台', quantity: 4 });
    expect(more.body.quantity).toBe(4);
    const fewer = await t.owner.patch('/v1/equipment', { shopId: t.shopId, name: 'シャンプー台', quantity: 3, isActive: false });
    expect(fewer.body).toMatchObject({ quantity: 3, isActive: false });

    // inactive equipment is listed only on request (the settings tab), with its quantity kept
    expect((await t.owner.get('/v1/equipment', { shopId: t.shopId })).body.map((e: { name: string }) => e.name)).toEqual(['個室']);
    const all = (await t.owner.get('/v1/equipment', { shopId: t.shopId, includeInactive: true })).body;
    expect(all).toEqual([
      { shopId: t.shopId, name: 'シャンプー台', quantity: 3, isActive: false },
      { shopId: t.shopId, name: '個室', quantity: 1, isActive: true },
    ]);

    const renamed = await t.owner.patch('/v1/equipment', { shopId: t.shopId, name: 'シャンプー台', newName: 'シャンプーブース', isActive: true });
    expect(renamed.body).toEqual({ shopId: t.shopId, name: 'シャンプーブース', quantity: 3, isActive: true });
    expect((await t.owner.patch('/v1/equipment', { shopId: t.shopId, name: 'シャンプーブース', newName: '個室' })).status).toBe(409);
    expect((await t.owner.patch('/v1/equipment', { shopId: t.shopId, name: '存在しない', quantity: 2 })).status).toBe(404);

    const removed = await t.owner.delete(`/v1/equipment?shopId=${t.shopId}&name=${encodeURIComponent('個室')}`);
    expect(removed.status).toBe(204);
    expect((await t.owner.get('/v1/equipment', { shopId: t.shopId, includeInactive: true })).body.map((e: { name: string }) => e.name)).toEqual(['シャンプーブース']);
    // the same name can be registered again after removal
    expect((await t.owner.post('/v1/equipment', { shopId: t.shopId, name: '個室', quantity: 2 })).status).toBe(201);
  });

  it('keeps simultaneous bookings within the quantity, follows renames, and stops limiting when switched off or removed', async () => {
    const t = await createTenant();
    const [s1, s2, s3] = await Promise.all([createStaffUser(t, 'stylist'), createStaffUser(t, 'stylist'), createStaffUser(t, 'stylist')]);
    await t.owner.post('/v1/equipment', { shopId: t.shopId, name: 'スパベッド', quantity: 1 });
    const menu = await createMenu(t, { name: 'ヘッドスパ', durationMin: 30, shopId: t.shopId, resourceRequirements: [{ resourceType: 'スパベッド', offsetMin: 0 }] });
    const date = nextWeekday(WED);
    const book = (staffId: string, time: string) => t.owner.post('/v1/appointments', { shopId: t.shopId, staffId, startAt: jst(date, time), menuIds: [menu.id] });

    expect((await book(s1.staffId, '11:00')).status).toBe(201);
    const full = await book(s2.staffId, '11:00');
    expect(full.status).toBe(409);
    expect(full.body.error.details.reason).toBe('resource_unavailable');

    // one more unit → one more simultaneous booking
    await t.owner.patch('/v1/equipment', { shopId: t.shopId, name: 'スパベッド', quantity: 2 });
    expect((await book(s2.staffId, '11:00')).status).toBe(201);
    expect((await book(s3.staffId, '11:00')).status).toBe(409);

    // renaming keeps the menu linked
    await t.owner.patch('/v1/equipment', { shopId: t.shopId, name: 'スパベッド', newName: 'ベッド' });
    const linked = (await t.owner.get(`/v1/menus/${menu.id}`)).body;
    expect(linked.resourceRequirements.map((r: { resource_type: string }) => r.resource_type)).toEqual(['ベッド']);
    expect((await book(s3.staffId, '11:00')).status).toBe(409);

    // 無効: the limit is not applied while the equipment is off
    await t.owner.patch('/v1/equipment', { shopId: t.shopId, name: 'ベッド', isActive: false });
    const whileOff = await book(s3.staffId, '11:00');
    expect(whileOff.status).toBe(201);
    expect(whileOff.body.resources).toHaveLength(0);
    await t.owner.post(`/v1/appointments/${whileOff.body.id}/cancel`, { reason: 'テスト' });
    await t.owner.patch('/v1/equipment', { shopId: t.shopId, name: 'ベッド', isActive: true });
    expect((await book(s3.staffId, '11:00')).status).toBe(409);

    // removed: the menu no longer asks for it
    expect((await t.owner.delete(`/v1/equipment?shopId=${t.shopId}&name=${encodeURIComponent('ベッド')}`)).status).toBe(204);
    expect((await t.owner.get(`/v1/menus/${menu.id}`)).body.resourceRequirements).toHaveLength(0);
    expect((await book(s3.staffId, '11:00')).status).toBe(201);
  });

  it('needs menu.manage and access to the shop', async () => {
    const t = await createTenant();
    const other = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.post('/v1/equipment', { shopId: t.shopId, name: 'シャンプー台', quantity: 1 })).status).toBe(403);
    // a shop of another organization does not exist for this one
    expect((await other.owner.post('/v1/equipment', { shopId: t.shopId, name: 'シャンプー台', quantity: 1 })).status).toBe(404);
    expect((await other.owner.get('/v1/equipment', { shopId: t.shopId })).status).toBe(404);
    expect((await t.owner.get('/v1/equipment', { shopId: t.shopId, includeInactive: true })).body).toEqual([]);
    expect((await t.owner.post('/v1/equipment', { shopId: t.shopId, name: '', quantity: 1 })).status).toBe(400);
    expect((await t.owner.post('/v1/equipment', { shopId: t.shopId, name: 'シャンプー台', quantity: 0 })).status).toBe(400);

    // a second shop the manager is not assigned to
    const second = (await t.owner.post('/v1/shops', { name: '2号店' })).body;
    const manager = await createStaffUser(t, 'manager');
    expect((await manager.api.post('/v1/equipment', { shopId: second.id, name: 'シャンプー台', quantity: 1 })).status).toBe(403);
    expect((await manager.api.post('/v1/equipment', { shopId: t.shopId, name: 'シャンプー台', quantity: 1 })).status).toBe(201);
  });
});
