import { describe, expect, it } from 'vitest';
import { api, createCustomer, createMenu, createStaffUser, createTenant, jst, jstDate, nextWeekday, runJobs, uploadTestFile } from '../../test/helpers.js';

const WED = 3;

type Menu = {
  id: string;
  name: string;
  status: string;
  sortOrder: number;
  categoryId: string | null;
  categoryName: string | null;
  subCategoryIds: string[];
  menuType: string;
  couponType: string | null;
  presentationCondition: string | null;
  usageCondition: string | null;
  expiryDate: string | null;
  priceTilde: boolean;
  newCustomerOnly: boolean;
  imageFileId: string | null;
  imageUrl: string | null;
  staffIds: string[];
  resourceRequirements: { resourceType: string; offsetMin: number; durationMin: number | null }[];
};

async function listMenus(t: { owner: ReturnType<typeof api>; shopId: string }, includeInactive = true, shopId = t.shopId): Promise<Menu[]> {
  const res = await t.owner.get('/v1/menus', { shopId, includeInactive });
  expect(res.status).toBe(200);
  return res.body;
}

describe('menu screens: categories with a parent', () => {
  it('stores a child as 「親：子」 with the parent colour and keeps both in step', async () => {
    const t = await createTenant();
    const parent = (await t.owner.post('/v1/menu-categories', { shopId: t.shopId, name: 'まつげ', color: '#EAB308', sortOrder: 1 })).body;
    expect(parent.parent_id).toBeNull();

    // the child part alone, or the full 「親：子」 spelling, give the same stored name
    const upper = await t.owner.post('/v1/menu-categories', { shopId: t.shopId, name: '上', parentId: parent.id, color: '#000000' });
    expect(upper.status).toBe(201);
    expect(upper.body).toMatchObject({ name: 'まつげ：上', color: '#EAB308', parent_id: parent.id });
    const lower = (await t.owner.post('/v1/menu-categories', { shopId: t.shopId, name: 'まつげ：下', parentId: parent.id })).body;
    expect(lower.name).toBe('まつげ：下');

    // renaming / recolouring the parent carries the children along
    const renamed = await t.owner.patch(`/v1/menu-categories/${parent.id}`, { name: 'アイ', color: '#3B82F6' });
    expect(renamed.body).toMatchObject({ name: 'アイ', color: '#3B82F6' });
    let list = (await t.owner.get('/v1/menu-categories', { shopId: t.shopId })).body as { id: string; name: string; color: string | null; parent_id: string | null }[];
    expect(list.find((c) => c.id === upper.body.id)).toMatchObject({ name: 'アイ：上', color: '#3B82F6', parent_id: parent.id });
    expect(list.find((c) => c.id === lower.id)).toMatchObject({ name: 'アイ：下', color: '#3B82F6' });

    // a child keeps its parent's colour and prefix whatever is sent
    const child = await t.owner.patch(`/v1/menu-categories/${upper.body.id}`, { name: '上まつげ', color: '#111111' });
    expect(child.body).toMatchObject({ name: 'アイ：上まつげ', color: '#3B82F6' });

    // two levels only
    expect((await t.owner.post('/v1/menu-categories', { shopId: t.shopId, name: '孫', parentId: lower.id })).status).toBe(400);
    expect((await t.owner.patch(`/v1/menu-categories/${parent.id}`, { parentId: parent.id })).status).toBe(400);
    const other = (await t.owner.post('/v1/menu-categories', { shopId: t.shopId, name: 'ネイル' })).body;
    expect((await t.owner.patch(`/v1/menu-categories/${parent.id}`, { parentId: other.id })).status).toBe(400); // has children

    // a child can move to another parent or become top-level
    const moved = await t.owner.patch(`/v1/menu-categories/${lower.id}`, { parentId: other.id });
    expect(moved.body).toMatchObject({ name: 'ネイル：下', parent_id: other.id, color: null });
    const top = await t.owner.patch(`/v1/menu-categories/${lower.id}`, { parentId: null });
    expect(top.body).toMatchObject({ name: '下', parent_id: null });

    // order
    const reorder = await t.owner.put('/v1/menu-categories/reorder', { items: [{ id: other.id, sortOrder: 0 }, { id: parent.id, sortOrder: 1 }, { id: lower.id, sortOrder: 2 }] });
    expect(reorder.status).toBe(200);
    list = (await t.owner.get('/v1/menu-categories', { shopId: t.shopId })).body;
    expect(list.filter((c) => !c.parent_id).map((c) => c.name)).toEqual(['ネイル', 'アイ', '下']);

    // deleting a parent takes its child categories with it; the menu that used the child stays, uncategorised
    const menu = await createMenu(t, { shopId: t.shopId, name: 'まつげパーマ', subCategoryIds: [upper.body.id] });
    expect((await t.owner.delete(`/v1/menu-categories/${parent.id}`)).status).toBe(204);
    list = (await t.owner.get('/v1/menu-categories', { shopId: t.shopId })).body;
    expect(list.map((c) => c.name).sort()).toEqual(['ネイル', '下'].sort());
    expect((await listMenus(t)).find((m) => m.id === menu.id)).toMatchObject({ categoryId: null, categoryName: null, subCategoryIds: [] });
  });

  it('全削除 removes every category of the shop and leaves the menus uncategorised', async () => {
    const t = await createTenant();
    const shop2 = (await t.owner.post('/v1/shops', { name: '2号店', slug: `s2-${Date.now()}-${Math.floor(Math.random() * 1e6)}` })).body;
    const eye = (await t.owner.post('/v1/menu-categories', { shopId: t.shopId, name: 'まつげ', color: '#EAB308' })).body;
    const upper = (await t.owner.post('/v1/menu-categories', { shopId: t.shopId, name: '上', parentId: eye.id })).body;
    const shared = (await t.owner.post('/v1/menu-categories', { name: '全店共通' })).body;
    const other = (await t.owner.post('/v1/menu-categories', { shopId: shop2.id, name: '2号店のカテゴリ' })).body;
    const a = await createMenu(t, { shopId: t.shopId, name: 'A', subCategoryIds: [upper.id, shared.id] });
    const b = await createMenu(t, { shopId: shop2.id, name: 'B', subCategoryIds: [other.id, shared.id] });

    // a shop manager deletes the shop's own categories; the shared one stays (it belongs to every shop)
    const manager = await createStaffUser(t, 'manager');
    expect((await manager.api.delete(`/v1/menu-categories/all?shopId=${shop2.id}`)).status).toBe(403);
    const byManager = await manager.api.delete(`/v1/menu-categories/all?shopId=${t.shopId}`);
    expect(byManager.status).toBe(200);
    expect(byManager.body).toEqual({ deleted: 2, kept: 1 });
    let list = (await t.owner.get('/v1/menu-categories', { shopId: t.shopId })).body as { id: string }[];
    expect(list.map((c) => c.id)).toEqual([shared.id]);
    // the menu is still there, now under the remaining category
    expect((await listMenus(t)).find((m) => m.id === a.id)).toMatchObject({ categoryId: shared.id, subCategoryIds: [shared.id], status: 'active' });

    // the owner (all shops) empties the list; the other shop's own category is not touched
    const byOwner = await t.owner.delete(`/v1/menu-categories/all?shopId=${t.shopId}`);
    expect(byOwner.body).toEqual({ deleted: 1, kept: 0 });
    list = (await t.owner.get('/v1/menu-categories', { shopId: t.shopId })).body;
    expect(list).toEqual([]);
    expect((await listMenus(t)).find((m) => m.id === a.id)).toMatchObject({ categoryId: null, categoryName: null, subCategoryIds: [] });
    expect((await listMenus(t, true, shop2.id)).find((m) => m.id === b.id)).toMatchObject({ categoryId: other.id, subCategoryIds: [other.id] });
    // nothing left: a second press deletes nothing
    expect((await t.owner.delete(`/v1/menu-categories/all?shopId=${t.shopId}`)).body).toEqual({ deleted: 0, kept: 0 });

    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.delete(`/v1/menu-categories/all?shopId=${t.shopId}`)).status).toBe(403);
    expect((await t.owner.delete('/v1/menu-categories/all')).status).toBe(400);
    // another organization cannot reach these categories through its own shop
    const foreign = await createTenant();
    expect((await foreign.owner.delete(`/v1/menu-categories/all?shopId=${foreign.shopId}`)).body).toEqual({ deleted: 0, kept: 0 });
    expect((await t.owner.get('/v1/menu-categories', { shopId: shop2.id })).body.map((c: { id: string }) => c.id)).toEqual([other.id]);
  });

  it('groups menus of child categories with their parent and frees menus of a deleted category', async () => {
    const t = await createTenant();
    const nail = (await t.owner.post('/v1/menu-categories', { shopId: t.shopId, name: 'ネイル', sortOrder: 0 })).body;
    const eye = (await t.owner.post('/v1/menu-categories', { shopId: t.shopId, name: 'まつげ', sortOrder: 1 })).body;
    const upper = (await t.owner.post('/v1/menu-categories', { shopId: t.shopId, name: '上', parentId: eye.id, sortOrder: 0 })).body;
    const lower = (await t.owner.post('/v1/menu-categories', { shopId: t.shopId, name: '下', parentId: eye.id, sortOrder: 1 })).body;

    const a = await createMenu(t, { shopId: t.shopId, name: 'A', subCategoryIds: [lower.id, upper.id], sortOrder: 0 });
    const b = await createMenu(t, { shopId: t.shopId, name: 'B', categoryId: upper.id, sortOrder: 1 });
    const c = await createMenu(t, { shopId: t.shopId, name: 'C', categoryId: nail.id, sortOrder: 5 });

    let menus = await listMenus(t);
    // ネイル (sort 0) first; inside まつげ the menu order wins over the child category order
    expect(menus.map((m) => m.name)).toEqual(['C', 'A', 'B']);
    expect(menus.find((m) => m.id === a.id)).toMatchObject({ categoryId: lower.id, categoryName: 'まつげ：下', subCategoryIds: [lower.id, upper.id] });
    expect(menus.find((m) => m.id === b.id)).toMatchObject({ categoryId: upper.id, subCategoryIds: [upper.id] });

    // unknown category
    expect((await t.owner.patch(`/v1/menus/${c.id}`, { subCategoryIds: ['00000000-0000-4000-8000-000000000000'] })).status).toBe(400);

    // deleting the main category promotes the next ticked one
    expect((await t.owner.delete(`/v1/menu-categories/${lower.id}`)).status).toBe(204);
    menus = await listMenus(t);
    expect(menus.find((m) => m.id === a.id)).toMatchObject({ categoryId: upper.id, subCategoryIds: [upper.id] });
    expect((await t.owner.delete(`/v1/menu-categories/${upper.id}`)).status).toBe(204);
    menus = await listMenus(t);
    expect(menus.find((m) => m.id === b.id)).toMatchObject({ categoryId: null, subCategoryIds: [] });

    // clearing the categories of a menu
    const cleared = await t.owner.patch(`/v1/menus/${c.id}`, { subCategoryIds: [] });
    expect(cleared.body).toMatchObject({ category_id: null, sub_category_ids: [] });
  });
});

describe('menu screens: coupons, 掲載 and order', () => {
  it('keeps coupon fields on coupon menus and hides expired ones from booking', async () => {
    const t = await createTenant();
    const created = await t.owner.post('/v1/menus', {
      shopId: t.shopId,
      name: '【ご新規様】カット+カラー',
      description: 'クーポンの詳細説明',
      durationMin: 90,
      price: 8000,
      menuType: 'coupon',
      couponType: 'new',
      presentationCondition: '予約時',
      usageCondition: '他クーポンとの併用不可',
      expiryDate: jstDate(30),
      priceTilde: true,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      menu_type: 'coupon',
      coupon_type: 'new',
      presentation_condition: '予約時',
      usage_condition: '他クーポンとの併用不可',
      expiry_date: jstDate(30),
      price_tilde: true,
      new_customer_only: true,
    });
    const regular = await createMenu(t, { shopId: t.shopId, name: 'カット', couponType: 'repeat', usageCondition: '無視される' });

    let menus = await listMenus(t, false);
    expect(menus.find((m) => m.id === created.body.id)).toMatchObject({ menuType: 'coupon', couponType: 'new', presentationCondition: '予約時', expiryDate: jstDate(30), priceTilde: true, newCustomerOnly: true });
    // coupon-only fields do not stick to a regular menu
    expect(menus.find((m) => m.id === regular.id)).toMatchObject({ menuType: 'regular', couponType: null, usageCondition: null, priceTilde: false });

    // today is still bookable, yesterday is not
    await t.owner.patch(`/v1/menus/${created.body.id}`, { expiryDate: jstDate(0) });
    expect((await listMenus(t, false)).some((m) => m.id === created.body.id)).toBe(true);
    await t.owner.patch(`/v1/menus/${created.body.id}`, { expiryDate: jstDate(-1) });
    menus = await listMenus(t, false);
    expect(menus.some((m) => m.id === created.body.id)).toBe(false);
    expect((await listMenus(t, true)).some((m) => m.id === created.body.id)).toBe(true);
    const date = nextWeekday(WED);
    const booking = await t.owner.post('/v1/appointments', { shopId: t.shopId, startAt: jst(date, '11:00'), menuIds: [created.body.id] });
    expect(booking.status).toBeGreaterThanOrEqual(400);

    // no expiry again; a regular menu switched to a coupon starts as 全員, and back clears the conditions
    const noExpiry = await t.owner.patch(`/v1/menus/${created.body.id}`, { expiryDate: null, couponType: 'repeat' });
    expect(noExpiry.body).toMatchObject({ expiry_date: null, coupon_type: 'repeat', new_customer_only: false });
    const switched = await t.owner.patch(`/v1/menus/${regular.id}`, { menuType: 'coupon' });
    expect(switched.body).toMatchObject({ menu_type: 'coupon', coupon_type: 'all' });
    const back = await t.owner.patch(`/v1/menus/${created.body.id}`, { menuType: 'regular' });
    expect(back.body).toMatchObject({ menu_type: 'regular', coupon_type: null, presentation_condition: null, usage_condition: null, expiry_date: null });

    expect((await t.owner.post('/v1/menus', { name: 'x', durationMin: 30, price: 0, menuType: 'gift' })).status).toBe(400);
    expect((await t.owner.post('/v1/menus', { name: 'x', durationMin: 30, price: 0, menuType: 'coupon', expiryDate: '2026/01/01' })).status).toBe(400);
  });

  it('switches 掲載 per shop: own menus by status, shared menus by the shop override', async () => {
    const t = await createTenant();
    const shop2 = (await t.owner.post('/v1/shops', { name: '2号店', slug: `s2-${Date.now()}-${Math.floor(Math.random() * 1e6)}` })).body;
    const own = await createMenu(t, { shopId: t.shopId, name: '店舗メニュー' });
    const shared = await createMenu(t, { name: '共通メニュー' });
    await t.owner.put(`/v1/menus/${shared.id}/shops/${t.shopId}`, { price: 7000 });

    const off = await t.owner.put(`/v1/menus/${own.id}/listing`, { shopId: t.shopId, listed: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ id: own.id, status: 'inactive' });
    expect((await listMenus(t, false)).some((m) => m.id === own.id)).toBe(false);
    expect((await t.owner.put(`/v1/menus/${own.id}/listing`, { shopId: t.shopId, listed: true })).body.status).toBe('active');
    // a menu of another shop
    expect((await t.owner.put(`/v1/menus/${own.id}/listing`, { shopId: shop2.id, listed: false })).status).toBe(400);

    // shared menu: hidden in this shop only, the price override survives
    const sharedOff = await t.owner.put(`/v1/menus/${shared.id}/listing`, { shopId: t.shopId, listed: false });
    expect(sharedOff.body).toMatchObject({ status: 'unavailable', price: 7000 });
    expect((await listMenus(t, false)).some((m) => m.id === shared.id)).toBe(false);
    expect((await listMenus(t, false, shop2.id)).some((m) => m.id === shared.id)).toBe(true);
    const sharedOn = await t.owner.put(`/v1/menus/${shared.id}/listing`, { shopId: t.shopId, listed: true });
    expect(sharedOn.body).toMatchObject({ status: 'active', price: 7000 });

    // switched off for everyone on the old screen: listing it again re-activates it
    await t.owner.patch(`/v1/menus/${shared.id}`, { status: 'inactive' });
    expect((await t.owner.put(`/v1/menus/${shared.id}/listing`, { shopId: shop2.id, listed: true })).body.status).toBe('active');

    // a shop manager cannot re-activate a shared menu, but can hide / show it in the own shop
    const manager = await createStaffUser(t, 'manager');
    await t.owner.patch(`/v1/menus/${shared.id}`, { status: 'inactive' });
    expect((await manager.api.put(`/v1/menus/${shared.id}/listing`, { shopId: t.shopId, listed: true })).status).toBe(403);
    await t.owner.patch(`/v1/menus/${shared.id}`, { status: 'active' });
    expect((await manager.api.put(`/v1/menus/${shared.id}/listing`, { shopId: t.shopId, listed: false })).body.status).toBe('unavailable');
    expect((await manager.api.put(`/v1/menus/${shared.id}/listing`, { shopId: shop2.id, listed: false })).status).toBe(403);

    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.put(`/v1/menus/${own.id}/listing`, { shopId: t.shopId, listed: false })).status).toBe(403);
  });

  it('creates a menu as 非掲載 and reorders menus', async () => {
    const t = await createTenant();
    const hidden = await t.owner.post('/v1/menus', { shopId: t.shopId, name: '準備中', durationMin: 30, price: 1000, status: 'inactive' });
    expect(hidden.body.status).toBe('inactive');
    const a = await createMenu(t, { shopId: t.shopId, name: 'A' });
    const b = await createMenu(t, { shopId: t.shopId, name: 'B' });
    const c = await createMenu(t, { shopId: t.shopId, name: 'C' });
    expect((await listMenus(t, false)).map((m) => m.name)).toEqual(['A', 'B', 'C']);

    const res = await t.owner.put('/v1/menus/reorder', { items: [{ id: c.id, sortOrder: 0 }, { id: a.id, sortOrder: 1 }, { id: b.id, sortOrder: 2 }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 3 });
    expect((await listMenus(t, false)).map((m) => m.name)).toEqual(['C', 'A', 'B']);

    expect((await t.owner.put('/v1/menus/reorder', { items: [] })).status).toBe(400);
    expect((await t.owner.put('/v1/menus/reorder', { items: [{ id: '00000000-0000-4000-8000-000000000000', sortOrder: 0 }] })).status).toBe(404);
    // tenant isolation: another organization cannot reorder (or see) these menus
    const other = await createTenant();
    expect((await other.owner.put('/v1/menus/reorder', { items: [{ id: a.id, sortOrder: 9 }] })).status).toBe(404);
    expect((await other.owner.put(`/v1/menus/${a.id}/listing`, { shopId: other.shopId, listed: false })).status).toBe(404);
    // shared menus need the all-shops permission, like editing them
    const shared = await createMenu(t, { name: '共通' });
    const manager = await createStaffUser(t, 'manager');
    expect((await manager.api.put('/v1/menus/reorder', { items: [{ id: shared.id, sortOrder: 0 }] })).status).toBe(403);
    expect((await manager.api.put('/v1/menus/reorder', { items: [{ id: a.id, sortOrder: 4 }] })).status).toBe(200);
    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.put('/v1/menus/reorder', { items: [{ id: a.id, sortOrder: 0 }] })).status).toBe(403);
    expect((await stylist.api.put('/v1/menu-categories/reorder', { items: [{ id: a.id, sortOrder: 0 }] })).status).toBe(403);
  });

  it('asks before deleting a menu that reservations use', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    const used = await createMenu(t, { shopId: t.shopId, name: '予約あり' });
    const unused = await createMenu(t, { shopId: t.shopId, name: '予約なし' });
    const customer = await createCustomer(t);
    const date = nextWeekday(WED);
    const appt = await t.owner.post('/v1/appointments', { shopId: t.shopId, customerId: customer.id, staffId: stylist.staffId, startAt: jst(date, '12:00'), menuIds: [used.id] });
    expect(appt.status).toBe(201);

    expect((await t.owner.delete(`/v1/menus/${unused.id}?checkUsage=true`)).status).toBe(204);
    const refused = await t.owner.delete(`/v1/menus/${used.id}?checkUsage=true`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'MENU_IN_USE', message: 'このメニューは予約で使用されています。' });
    expect((await listMenus(t)).some((m) => m.id === used.id)).toBe(true);

    // confirmed: hidden from the lists, the reservation keeps its line
    expect((await t.owner.delete(`/v1/menus/${used.id}`)).status).toBe(204);
    expect((await listMenus(t)).some((m) => m.id === used.id)).toBe(false);
    const after = await t.owner.get(`/v1/appointments/${appt.body.id}`);
    expect(after.body.services[0]).toMatchObject({ menu_id: used.id, name: '予約あり' });
  });
});

describe('menu screens: picture', () => {
  it('attaches, serves, replaces and removes the menu picture', async () => {
    const t = await createTenant();
    const menu = await createMenu(t, { shopId: t.shopId });
    const first = await uploadTestFile(t.owner, { purpose: 'menu_image', fileName: 'cut.png' });

    const attached = await t.owner.patch(`/v1/menus/${menu.id}`, { imageFileId: first.fileId });
    expect(attached.status).toBe(200);
    expect(attached.body.image_file_id).toBe(first.fileId);
    expect(attached.body.image_url).toMatch(/\/v1\/files\/blob\//);

    const listed = (await listMenus(t)).find((m) => m.id === menu.id)!;
    expect(listed.imageFileId).toBe(first.fileId);
    const blob = await api().get(new URL(listed.imageUrl!).pathname);
    expect(blob.status).toBe(200);
    expect(blob.headers['content-type']).toBe('image/png');

    // only uploaded menu pictures can be attached
    const photo = await uploadTestFile(t.owner, { purpose: 'karte_photo' });
    expect((await t.owner.patch(`/v1/menus/${menu.id}`, { imageFileId: photo.fileId })).status).toBe(400);
    expect((await t.owner.patch(`/v1/menus/${menu.id}`, { imageFileId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    const other = await createTenant();
    const foreign = await uploadTestFile(other.owner, { purpose: 'menu_image' });
    expect((await t.owner.patch(`/v1/menus/${menu.id}`, { imageFileId: foreign.fileId })).status).toBe(404);
    // an update that does not mention the picture keeps it
    expect((await t.owner.patch(`/v1/menus/${menu.id}`, { name: 'カット（改）' })).body.image_file_id).toBe(first.fileId);

    // replacing deletes the previous file; null removes the picture
    const second = await uploadTestFile(t.owner, { purpose: 'menu_image' });
    expect((await t.owner.patch(`/v1/menus/${menu.id}`, { imageFileId: second.fileId })).body.image_file_id).toBe(second.fileId);
    expect((await t.owner.get(`/v1/files/${first.fileId}`)).status).toBe(404);
    const removed = await t.owner.patch(`/v1/menus/${menu.id}`, { imageFileId: null });
    expect(removed.body).toMatchObject({ image_file_id: null, image_url: null });
    expect((await t.owner.get(`/v1/files/${second.fileId}`)).status).toBe(404);
    expect((await listMenus(t)).find((m) => m.id === menu.id)).toMatchObject({ imageFileId: null, imageUrl: null });
    await runJobs();

    // uploading needs the menu permission, and only browser-displayable images are accepted
    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.post('/v1/files/presign', { purpose: 'menu_image', contentType: 'image/png', sizeBytes: 100 })).status).toBe(403);
    expect((await t.owner.post('/v1/files/presign', { purpose: 'menu_image', contentType: 'image/heic', sizeBytes: 100 })).status).toBe(415);

    // a new menu can be created with its picture
    const third = await uploadTestFile(t.owner, { purpose: 'menu_image' });
    const created = await t.owner.post('/v1/menus', { shopId: t.shopId, name: 'カラー', durationMin: 60, price: 6000, imageFileId: third.fileId });
    expect(created.body.image_url).toMatch(/\/v1\/files\/blob\//);
  });
});

describe('menu screens: 対応スタッフ / 対応設備', () => {
  it('saves the staff matrix without touching other staff or per-staff prices', async () => {
    const t = await createTenant();
    const s1 = await createStaffUser(t, 'stylist');
    const s2 = await createStaffUser(t, 'stylist');
    const outside = await createStaffUser(t, 'stylist');
    const cut = await createMenu(t, { shopId: t.shopId, name: 'カット' });
    const color = await createMenu(t, { shopId: t.shopId, name: 'カラー' });
    // s1 has a rank price on カット; a staff who is not a column of the matrix is assigned too
    await t.owner.put(`/v1/staff/${s1.staffId}/menus`, { menus: [{ menuId: cut.id, price: 7700 }] });
    await t.owner.put(`/v1/staff/${outside.staffId}/menus`, { menus: [{ menuId: cut.id }] });

    const res = await t.owner.put('/v1/menus/staff-assignments', {
      shopId: t.shopId,
      staffIds: [s1.staffId, s2.staffId],
      assignments: [
        { menuId: cut.id, staffIds: [s1.staffId, s2.staffId] },
        { menuId: color.id, staffIds: [s2.staffId] },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ menus: 2, added: 2, removed: 0 });

    let menus = await listMenus(t);
    expect(new Set(menus.find((m) => m.id === cut.id)!.staffIds)).toEqual(new Set([s1.staffId, s2.staffId, outside.staffId]));
    expect(menus.find((m) => m.id === color.id)!.staffIds).toEqual([s2.staffId]);
    const detail = await t.owner.get(`/v1/menus/${cut.id}`);
    expect(detail.body.staff.find((s: { staff_id: string }) => s.staff_id === s1.staffId)).toMatchObject({ price: 7700 });

    // unticking removes only the columns of this matrix
    const second = await t.owner.put('/v1/menus/staff-assignments', {
      shopId: t.shopId,
      staffIds: [s1.staffId, s2.staffId],
      assignments: [{ menuId: cut.id, staffIds: [] }],
    });
    expect(second.body).toEqual({ menus: 1, added: 0, removed: 2 });
    menus = await listMenus(t);
    expect(menus.find((m) => m.id === cut.id)!.staffIds).toEqual([outside.staffId]);
    expect(menus.find((m) => m.id === color.id)!.staffIds).toEqual([s2.staffId]);

    // the assignment decides who can take the reservation
    const date = nextWeekday(WED);
    const no = await t.owner.post('/v1/appointments', { shopId: t.shopId, staffId: s2.staffId, startAt: jst(date, '11:00'), menuIds: [cut.id] });
    expect(no.status).toBeGreaterThanOrEqual(400);
    const yes = await t.owner.post('/v1/appointments', { shopId: t.shopId, staffId: s2.staffId, startAt: jst(date, '11:00'), menuIds: [color.id] });
    expect(yes.status).toBe(201);

    // deleting the only menu a staff is assigned to lifts the restriction (no rows = every menu)
    expect((await t.owner.delete(`/v1/menus/${color.id}`)).status).toBe(204);
    const freed = await t.owner.post('/v1/appointments', { shopId: t.shopId, staffId: s2.staffId, startAt: jst(date, '14:00'), menuIds: [cut.id] });
    expect(freed.status).toBe(201);

    // validation, permission, tenant
    expect((await t.owner.put('/v1/menus/staff-assignments', { shopId: t.shopId, staffIds: [s1.staffId], assignments: [{ menuId: cut.id, staffIds: [s2.staffId] }] })).status).toBe(400);
    expect((await t.owner.put('/v1/menus/staff-assignments', { shopId: t.shopId, staffIds: ['00000000-0000-4000-8000-000000000000'], assignments: [] })).status).toBe(400);
    expect((await s1.api.put('/v1/menus/staff-assignments', { shopId: t.shopId, staffIds: [], assignments: [] })).status).toBe(403);
    const other = await createTenant();
    expect((await other.owner.put('/v1/menus/staff-assignments', { shopId: other.shopId, staffIds: [], assignments: [{ menuId: cut.id, staffIds: [] }] })).status).toBe(404);
    // another organization's staff ids are invisible (RLS)
    expect((await other.owner.put('/v1/menus/staff-assignments', { shopId: other.shopId, staffIds: [s1.staffId], assignments: [] })).status).toBe(400);
  });

  it('saves the equipment matrix as resource requirements that limit bookings', async () => {
    const t = await createTenant();
    const s1 = await createStaffUser(t, 'stylist');
    const s2 = await createStaffUser(t, 'stylist');
    await t.owner.post('/v1/resources', { shopId: t.shopId, name: 'ベッド1', resourceType: 'ベッド' });
    await t.owner.post('/v1/resources', { shopId: t.shopId, name: 'シャンプー台1', resourceType: 'shampoo' });
    const spa = await createMenu(t, { shopId: t.shopId, name: 'ヘッドスパ', durationMin: 30, resourceRequirements: [{ resourceType: 'shampoo', offsetMin: 10, durationMin: 15 }, { resourceType: 'room', offsetMin: 0 }] });
    const cut = await createMenu(t, { shopId: t.shopId, name: 'カット', durationMin: 30 });

    const res = await t.owner.put('/v1/menus/equipment-assignments', {
      shopId: t.shopId,
      resourceTypes: ['ベッド', 'shampoo'],
      assignments: [
        { menuId: spa.id, resourceTypes: ['ベッド', 'shampoo'] },
        { menuId: cut.id, resourceTypes: [] },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ menus: 2, added: 1, removed: 0 });
    let menus = await listMenus(t);
    const reqs = menus.find((m) => m.id === spa.id)!.resourceRequirements;
    // the kept requirement keeps its timing; one outside the columns (room) is untouched
    expect(reqs).toEqual(
      expect.arrayContaining([
        { resourceType: 'shampoo', offsetMin: 10, durationMin: 15 },
        { resourceType: 'room', offsetMin: 0, durationMin: null },
        { resourceType: 'ベッド', offsetMin: 0, durationMin: null },
      ]),
    );
    expect(reqs).toHaveLength(3);
    expect(menus.find((m) => m.id === cut.id)!.resourceRequirements).toEqual([]);

    const untick = await t.owner.put('/v1/menus/equipment-assignments', {
      shopId: t.shopId,
      resourceTypes: ['ベッド', 'shampoo'],
      assignments: [
        { menuId: spa.id, resourceTypes: [] },
        { menuId: cut.id, resourceTypes: ['ベッド'] },
      ],
    });
    expect(untick.body).toEqual({ menus: 2, added: 1, removed: 2 });
    menus = await listMenus(t);
    expect(menus.find((m) => m.id === spa.id)!.resourceRequirements).toEqual([{ resourceType: 'room', offsetMin: 0, durationMin: null }]);

    // one bed: a second カット at the same time is refused although another stylist is free
    const date = nextWeekday(WED);
    const a = await t.owner.post('/v1/appointments', { shopId: t.shopId, staffId: s1.staffId, startAt: jst(date, '11:00'), menuIds: [cut.id] });
    expect(a.status).toBe(201);
    expect(a.body.resources).toHaveLength(1);
    const b = await t.owner.post('/v1/appointments', { shopId: t.shopId, staffId: s2.staffId, startAt: jst(date, '11:00'), menuIds: [cut.id] });
    expect(b.status).toBe(409);
    expect(b.body.error.details.reason).toBe('resource_unavailable');

    expect((await t.owner.put('/v1/menus/equipment-assignments', { shopId: t.shopId, resourceTypes: ['ベッド'], assignments: [{ menuId: cut.id, resourceTypes: ['room'] }] })).status).toBe(400);
    expect((await s1.api.put('/v1/menus/equipment-assignments', { shopId: t.shopId, resourceTypes: [], assignments: [] })).status).toBe(403);
    const other = await createTenant();
    expect((await other.owner.put('/v1/menus/equipment-assignments', { shopId: other.shopId, resourceTypes: ['ベッド'], assignments: [{ menuId: cut.id, resourceTypes: [] }] })).status).toBe(404);
  });
});
