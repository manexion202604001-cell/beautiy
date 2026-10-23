import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TEST_PNG,
  createMenu,
  createStaffUser,
  createTenant,
  uploadTestFile,
} from '../../test/helpers.js';

type Menu = {
  id: string;
  name: string;
  status: string;
  sortOrder: number;
  price: number;
  durationMin: number;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  menuType: string;
  couponType: string | null;
  usageCondition: string | null;
  presentationCondition: string | null;
  priceTilde: boolean;
  imageFileId: string | null;
  staffIds: string[];
  resourceRequirements: { resourceType: string }[];
};
type Category = {
  id: string;
  name: string;
  color: string | null;
  parent_id: string | null;
  sort_order: number;
};

async function menusOf(t: Awaited<ReturnType<typeof createTenant>>): Promise<Menu[]> {
  return (await t.owner.get('/v1/menus', { shopId: t.shopId, includeInactive: true })).body;
}
const byName = (list: Menu[], name: string) => list.find((m) => m.name === name)!;

describe('サロンボードから取込: menus and coupons with the comparison table', () => {
  it('compares SALON BOARD menus with the shop’s and imports the ticked rows', async () => {
    const t = await createTenant();
    const existing = await createMenu(t, {
      shopId: t.shopId,
      name: 'カット + カラー',
      price: 8000,
      durationMin: 90,
      sortOrder: 4,
    });
    const same = await createMenu(t, {
      shopId: t.shopId,
      name: 'パリジェンヌ',
      price: 7000,
      durationMin: 60,
      description: '自まつげ',
    });
    const gone = await createMenu(t, { shopId: t.shopId, name: '廃止メニュー', price: 3000 });
    const coupon = await createMenu(t, {
      shopId: t.shopId,
      name: '別種のクーポン',
      menuType: 'coupon',
      couponType: 'all',
    });
    const { fileId } = await uploadTestFile(t.owner, { purpose: 'menu_image' });
    await t.owner.patch(`/v1/menus/${existing.id}`, { imageFileId: fileId });

    const items = [
      // matched without spaces; price, time, tilde, category and spelling differ
      {
        category: 'まつげ・メイクなど：まつげデザイン',
        name: 'カット+カラー',
        description: '',
        price: 8800,
        durationMin: 100,
        priceTilde: true,
        listed: true,
        imageUrl: 'https://imgbp.salonboard.com/a.jpg',
      },
      {
        category: '',
        name: 'パリジェンヌ',
        description: '自まつげ',
        price: 7000,
        durationMin: 60,
        priceTilde: false,
        listed: true,
      },
      {
        category: 'まつげ・メイクなど：まつげデザイン',
        name: '新メニュー',
        description: '説明',
        price: 5000,
        durationMin: 0,
        priceTilde: false,
        listed: false,
        imageUrl: 'https://imgbp.salonboard.com/b.jpg',
      },
      { name: '  ' },
    ];
    const preview = await t.owner.post('/v1/menus/sb-import/preview', {
      shopId: t.shopId,
      kind: 'regular',
      items,
    });
    expect(preview.status).toBe(200);
    const rows = preview.body.rows as {
      index: number;
      kind: string;
      selected: boolean;
      existing: { id: string } | null;
      changes: { label: string; from: string; to: string }[];
    }[];
    expect(rows.map((r) => [r.index, r.kind, r.selected])).toEqual([
      [0, 'update', true],
      [1, 'same', false],
      [2, 'new', true],
    ]);
    expect(rows[0]!.existing!.id).toBe(existing.id);
    expect(rows[0]!.changes.map((c) => c.label)).toEqual([
      '〜表示',
      '価格',
      '時間',
      'カテゴリ',
      '表記',
    ]);
    expect(rows[0]!.changes.find((c) => c.label === '価格')).toEqual({
      label: '価格',
      from: '¥8,000',
      to: '¥8,800',
    });
    expect(rows[1]!.existing!.id).toBe(same.id);
    expect(preview.body.invalid).toBe(1);
    // 「SBに無い」: listed menus of the same kind only (the coupon is another kind)
    expect(preview.body.missing.map((m: { id: string }) => m.id)).toEqual([gone.id]);

    const run = await t.owner.post('/v1/menus/sb-import', {
      shopId: t.shopId,
      mode: 'compare',
      kind: 'regular',
      items,
      selected: [0, 1, 2],
      overwriteDetails: true,
      hideMenuIds: [gone.id, coupon.id],
    });
    expect(run.status).toBe(200);
    // the coupon is not a 「SBに無い」 row of this import: refused, counted as skipped
    expect(run.body).toMatchObject({ created: 1, updated: 1, hidden: 1, skipped: 1 });
    // only the menu without a picture takes the SALON BOARD one
    expect(run.body.images).toEqual([
      { menuId: expect.any(String), url: 'https://imgbp.salonboard.com/b.jpg' },
    ]);

    const after = await menusOf(t);
    const max = 4;
    // the spelling (表記) is shown as a difference but the Salon OS name is kept
    expect(byName(after, 'カット + カラー')).toMatchObject({
      id: existing.id,
      price: 8800,
      durationMin: 100,
      priceTilde: true,
      sortOrder: max + 1,
      categoryName: 'まつげ・メイクなど：まつげデザイン',
    });
    expect(byName(after, '新メニュー')).toMatchObject({
      status: 'inactive',
      durationMin: 60,
      sortOrder: max + 1 + 2,
      menuType: 'regular',
      categoryName: 'まつげ・メイクなど：まつげデザイン',
    });
    expect(run.body.images[0].menuId).toBe(byName(after, '新メニュー').id);
    expect(byName(after, 'パリジェンヌ').sortOrder).toBe(0); // 変更なし: untouched
    // hidden, never deleted
    expect(byName(after, '廃止メニュー').status).toBe('inactive');
    expect(byName(after, '別種のクーポン').status).toBe('active');

    // the category was created as parent (palette colour) + 「親：子」, once
    const cats = (await t.owner.get('/v1/menu-categories', { shopId: t.shopId }))
      .body as Category[];
    const parent = cats.find((c) => c.name === 'まつげ・メイクなど')!;
    expect(parent).toMatchObject({ parent_id: null, color: '#6B7280' });
    expect(cats.filter((c) => c.name === 'まつげ・メイクなど：まつげデザイン')).toEqual([
      expect.objectContaining({ parent_id: parent.id }),
    ]);
  });

  it('without 「価格・時間・説明・カテゴリも上書き」 updates only 掲載・〜表示・並び順・種別', async () => {
    const t = await createTenant();
    const c = await createMenu(t, {
      shopId: t.shopId,
      name: '【新規】カット',
      price: 5000,
      durationMin: 60,
      menuType: 'coupon',
      couponType: 'all',
      description: '前の説明',
    });
    const items = [
      {
        name: '【新規】カット',
        couponType: 'new',
        price: 4000,
        durationMin: 45,
        priceTilde: true,
        description: '新しい説明',
        category: '',
        usageCondition: '新規の方限定',
      },
    ];
    const preview = (
      await t.owner.post('/v1/menus/sb-import/preview', { shopId: t.shopId, kind: 'coupon', items })
    ).body;
    expect(preview.rows[0].changes.map((x: { label: string }) => x.label)).toEqual([
      '〜表示',
      'クーポン種別',
      '価格',
      '時間',
      '説明',
    ]);
    expect(preview.rows[0].changes[1]).toEqual({ label: 'クーポン種別', from: '全員', to: '新規' });

    const run = await t.owner.post('/v1/menus/sb-import', {
      shopId: t.shopId,
      mode: 'compare',
      kind: 'coupon',
      items,
      selected: [0],
      overwriteDetails: false,
    });
    expect(run.body).toMatchObject({ created: 0, updated: 1, hidden: 0, skipped: 0 });
    const m = byName(await menusOf(t), '【新規】カット');
    expect(m).toMatchObject({
      id: c.id,
      price: 5000,
      durationMin: 60,
      description: '前の説明',
      priceTilde: true,
      couponType: 'new',
      usageCondition: '新規の方限定',
    });
  });

  it('an unticked row and a 変更なし row are left alone', async () => {
    const t = await createTenant();
    await createMenu(t, { shopId: t.shopId, name: 'カット', price: 5000 });
    const items = [
      { name: 'カット', price: 6000, durationMin: 60 },
      { name: '追加しない', price: 1000 },
    ];
    const run = await t.owner.post('/v1/menus/sb-import', {
      shopId: t.shopId,
      mode: 'compare',
      kind: 'regular',
      items,
      selected: [],
    });
    expect(run.body).toMatchObject({ created: 0, updated: 0, hidden: 0, skipped: 0 });
    expect((await menusOf(t)).map((m) => [m.name, m.price])).toEqual([['カット', 5000]]);
  });

  it('matches a name written with full-width spaces', async () => {
    const t = await createTenant();
    const m = await createMenu(t, { shopId: t.shopId, name: 'ラッシュ\u3000リフト', price: 5000 });
    const preview = (
      await t.owner.post('/v1/menus/sb-import/preview', {
        shopId: t.shopId,
        kind: 'regular',
        items: [{ name: 'ラッシュ リフト', price: 5000, durationMin: 60 }],
      })
    ).body;
    expect(preview.rows[0]).toMatchObject({
      kind: 'update',
      existing: { id: m.id },
      changes: [{ label: '表記' }],
    });
  });

  it('a stylist without menu.manage cannot import', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    expect(
      (
        await stylist.api.post('/v1/menus/sb-import/preview', {
          shopId: t.shopId,
          kind: 'regular',
          items: [],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await stylist.api.post('/v1/menus/sb-import', {
          shopId: t.shopId,
          mode: 'single',
          items: [{ name: 'x' }],
        })
      ).status,
    ).toBe(403);
  });
});

describe('サロンボードから取込（個別）', () => {
  it('updates by exact name without touching price / time / description, or creates the coupon', async () => {
    const t = await createTenant();
    const c = await createMenu(t, {
      shopId: t.shopId,
      name: '【全員】まつげパーマ',
      price: 6000,
      durationMin: 60,
      menuType: 'coupon',
      couponType: 'all',
      status: 'inactive',
    });
    await createMenu(t, { shopId: t.shopId, name: '【再来】 ネイル', price: 4000 });
    const items = [
      {
        name: '【全員】まつげパーマ',
        couponType: 'repeat',
        price: 5500,
        durationMin: 75,
        description: 'x',
        usageCondition: '再来の方',
        presentationCondition: '予約時',
      },
      // exact name only: 「【再来】 ネイル」 with a space is another menu
      {
        name: '【再来】ネイル',
        couponType: 'repeat',
        price: 4500,
        durationMin: 60,
        category: 'ネイル：ジェル',
        description: 'ジェルネイル',
        presentationCondition: '来店時',
        imageUrl: 'https://imgbp.salonboard.com/c.jpg',
      },
      { name: '' },
    ];
    const run = await t.owner.post('/v1/menus/sb-import', {
      shopId: t.shopId,
      mode: 'single',
      items,
    });
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ created: 1, updated: 1, skipped: 1 });
    const list = await menusOf(t);
    expect(byName(list, '【全員】まつげパーマ')).toMatchObject({
      id: c.id,
      price: 6000,
      durationMin: 60,
      status: 'active',
      couponType: 'repeat',
      usageCondition: '再来の方',
      presentationCondition: '予約時',
    });
    const created = byName(list, '【再来】ネイル');
    expect(created).toMatchObject({
      menuType: 'coupon',
      couponType: 'repeat',
      price: 4500,
      description: 'ジェルネイル',
      presentationCondition: '来店時',
      categoryName: 'ネイル：ジェル',
    });
    expect(run.body.images).toEqual([
      { menuId: created.id, url: 'https://imgbp.salonboard.com/c.jpg' },
    ]);
    expect(byName(list, '【再来】 ネイル').price).toBe(4000);
  });
});

describe('対応スタッフ表 / 対応設備表の取込', () => {
  it('maps SALON BOARD stylists by the connector’s table and by name, and replaces their assignments', async () => {
    const t = await createTenant();
    const a = await createStaffUser(t, 'stylist', { displayName: '佐藤 花子' });
    const b = await createStaffUser(t, 'stylist', { displayName: 'mizuki' });
    const c = await createStaffUser(t, 'stylist', { displayName: 'SBに出ない人' });
    const cut = await createMenu(t, { shopId: t.shopId, name: 'カット' });
    const color = await createMenu(t, { shopId: t.shopId, name: 'カラー + トリートメント' });
    const self = await createMenu(t, { shopId: t.shopId, name: 'セルフ脱毛' });
    const cp = await createMenu(t, {
      shopId: t.shopId,
      name: 'カット',
      menuType: 'coupon',
      couponType: 'new',
    });
    // before: b does カット, c does カラー (c is not on SALON BOARD and keeps it)
    await t.owner.put('/v1/menus/staff-assignments', {
      shopId: t.shopId,
      staffIds: [b.staffId, c.staffId],
      assignments: [
        { menuId: cut.id, staffIds: [b.staffId] },
        { menuId: color.id, staffIds: [c.staffId] },
      ],
    });
    const integ = await t.owner.post('/v1/integrations', {
      provider: 'hotpepper_mail',
      shopId: t.shopId,
      displayName: 'SALON BOARD',
      config: { staffMap: { 'はなこ★': a.staffId } },
    });
    expect(integ.status).toBe(201);

    const res = await t.owner.post('/v1/menus/import/staff-assignments', {
      shopId: t.shopId,
      staffNames: ['はなこ★', '🌙mizuki🌙', '知らない人'],
      assignments: [
        { menuName: 'カット', kind: 'coupon', noStaffNeeded: false, assignedStaff: ['はなこ★'] },
        {
          menuName: 'カラー+トリートメント',
          noStaffNeeded: false,
          assignedStaff: ['はなこ★', '🌙mizuki🌙', '知らない人'],
        },
        { menuName: 'セルフ脱毛', noStaffNeeded: true, assignedStaff: [] },
        { menuName: '無いメニュー', noStaffNeeded: false, assignedStaff: ['はなこ★'] },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      menus: 3,
      staff: 2,
      noStaffNeeded: 1,
      unmatchedMenus: ['無いメニュー'],
      unmatchedStaff: ['知らない人'],
    });
    expect(res.body.message).toContain('3件のメニューの対応スタッフを取り込みました');

    const list = await menusOf(t);
    const staffOf = (id: string) => [...list.find((m) => m.id === id)!.staffIds].sort();
    // the coupon row went to the coupon of that name, not the regular カット
    expect(staffOf(cp.id)).toEqual([a.staffId]);
    expect(staffOf(cut.id)).toEqual([b.staffId]);
    expect(staffOf(color.id)).toEqual([a.staffId, b.staffId, c.staffId].sort());
    // スタッフ不要 → open to every SALON BOARD stylist
    expect(staffOf(self.id)).toEqual([a.staffId, b.staffId].sort());
  });

  it('imports the equipment table onto the shop’s equipment, skipping 設備不要 and unknown names', async () => {
    const t = await createTenant();
    await t.owner.post('/v1/equipment', {
      shopId: t.shopId,
      name: 'リクライニングソファ',
      quantity: 2,
    });
    await t.owner.post('/v1/equipment', { shopId: t.shopId, name: 'ネイルデスク', quantity: 1 });
    const cut = await createMenu(t, {
      shopId: t.shopId,
      name: 'まつげパーマ',
      resourceRequirements: [{ resourceType: 'ネイルデスク', offsetMin: 0 }],
    });
    const nail = await createMenu(t, { shopId: t.shopId, name: 'ジェルネイル' });
    const res = await t.owner.post('/v1/menus/import/equipment-assignments', {
      shopId: t.shopId,
      equipmentNames: ['リクライニング ソファ', 'ネイルデスク', '設備不要', '個室'],
      assignments: [
        { menuName: 'まつげパーマ', assignedEquipment: ['リクライニング ソファ'] },
        { menuName: 'ジェルネイル', assignedEquipment: ['ネイルデスク', '個室'] },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      menus: 2,
      equipment: 2,
      unmatchedEquipment: ['個室'],
      unmatchedMenus: [],
    });
    const list = await menusOf(t);
    expect(
      list.find((m) => m.id === cut.id)!.resourceRequirements.map((r) => r.resourceType),
    ).toEqual(['リクライニングソファ']);
    expect(
      list.find((m) => m.id === nail.id)!.resourceRequirements.map((r) => r.resourceType),
    ).toEqual(['ネイルデスク']);
  });
});

describe('カテゴリ管理「SBから取込」', () => {
  it('creates missing parents in palette order and 「親：子」 children, skipping existing ones', async () => {
    const t = await createTenant();
    const nail = (
      await t.owner.post('/v1/menu-categories', {
        shopId: t.shopId,
        name: 'ネイル',
        color: '#EC4899',
      })
    ).body;
    await t.owner.post('/v1/menu-categories', {
      shopId: t.shopId,
      name: 'ジェル',
      parentId: nail.id,
    });
    const res = await t.owner.post('/v1/menu-categories/import', {
      shopId: t.shopId,
      groups: [
        { parent: 'ネイル', children: ['ジェル', 'スカルプ'] },
        { parent: 'まつげ', children: ['まつげパーマ', '', 'まつげエクステ'] },
        { parent: 'エステ', children: [] },
        { parent: '', children: ['x'] },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      parents: 2,
      children: 3,
      skipped: 1,
      message: '親カテゴリ 2件、子カテゴリ 3件を作成しました。（1件スキップ）',
    });
    const cats = (await t.owner.get('/v1/menu-categories', { shopId: t.shopId }))
      .body as Category[];
    const eye = cats.find((c) => c.name === 'まつげ')!;
    // one parent existed: the next ones take the 2nd and 3rd palette colours
    expect(eye.color).toBe('#EF4444');
    expect(cats.find((c) => c.name === 'エステ')!.color).toBe('#F97316');
    expect(cats.filter((c) => c.parent_id === eye.id).map((c) => [c.name, c.color])).toEqual([
      ['まつげ：まつげパーマ', '#EF4444'],
      ['まつげ：まつげエクステ', '#EF4444'],
    ]);
    expect(
      cats
        .filter((c) => c.parent_id === nail.id)
        .map((c) => c.name)
        .sort(),
    ).toEqual(['ネイル：ジェル', 'ネイル：スカルプ']);

    const again = await t.owner.post('/v1/menu-categories/import', {
      shopId: t.shopId,
      groups: [{ parent: 'まつげ', children: ['まつげパーマ'] }],
    });
    expect(again.body.message).toBe(
      '親カテゴリ 0件、子カテゴリ 0件を作成しました。（1件スキップ）',
    );
  });
});

describe('POST /v1/menus/:id/image-from-url', () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (
    body: Buffer | string,
    init: { status?: number; headers?: Record<string, string> } = {},
  ) =>
    new Response(typeof body === 'string' ? body : new Uint8Array(body), {
      status: init.status ?? 200,
      headers: init.headers ?? { 'content-type': 'image/png' },
    });

  it('fetches a SALON BOARD picture and makes it the menu picture', async () => {
    const t = await createTenant();
    const menu = await createMenu(t, { shopId: t.shopId, name: 'カット' });
    const fetchMock = vi.fn(async (_url: URL | string) => respond(TEST_PNG));
    vi.stubGlobal('fetch', fetchMock);
    const res = await t.owner.post(`/v1/menus/${menu.id}/image-from-url`, {
      url: 'https://imgbp.salonboard.com/CLP/img/a.png?w=600&h=600',
    });
    expect(res.status).toBe(200);
    expect(res.body.image_file_id).toEqual(expect.any(String));
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://imgbp.salonboard.com/CLP/img/a.png?w=600&h=600',
    );
    expect((await menusOf(t)).find((m) => m.id === menu.id)!.imageFileId).toBe(
      res.body.image_file_id,
    );
  });

  it('refuses anything but https on a SALON BOARD host, before fetching', async () => {
    const t = await createTenant();
    const menu = await createMenu(t, { shopId: t.shopId, name: 'カット' });
    const fetchMock = vi.fn(async () => respond(TEST_PNG));
    vi.stubGlobal('fetch', fetchMock);
    for (const url of [
      'http://imgbp.salonboard.com/a.png',
      'https://example.com/a.png',
      'https://salonboard.com.example.com/a.png',
      'https://imgbp.salonboard.com:8443/a.png',
      'https://user:pw@imgbp.salonboard.com/a.png',
      'https://127.0.0.1/a.png',
      'not a url',
    ]) {
      expect((await t.owner.post(`/v1/menus/${menu.id}/image-from-url`, { url })).status, url).toBe(
        400,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-checks redirects and refuses other types or oversized pictures', async () => {
    const t = await createTenant();
    const menu = await createMenu(t, { shopId: t.shopId, name: 'カット' });
    const url = 'https://imgbp.salonboard.com/a.png';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        respond('', { status: 302, headers: { location: 'https://169.254.169.254/latest' } }),
      ),
    );
    expect((await t.owner.post(`/v1/menus/${menu.id}/image-from-url`, { url })).status).toBe(400);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond('<html></html>', { headers: { 'content-type': 'text/html' } })),
    );
    expect((await t.owner.post(`/v1/menus/${menu.id}/image-from-url`, { url })).status).toBe(400);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        respond(TEST_PNG, {
          headers: { 'content-type': 'image/png', 'content-length': String(11 * 1024 * 1024) },
        }),
      ),
    );
    expect((await t.owner.post(`/v1/menus/${menu.id}/image-from-url`, { url })).status).toBe(400);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond('', { status: 404 })),
    );
    expect((await t.owner.post(`/v1/menus/${menu.id}/image-from-url`, { url })).status).toBe(502);
    // a redirect within SALON BOARD is followed
    const hops = vi.fn(async (u: URL | string) =>
      String(u).endsWith('/a.png')
        ? respond('', { status: 301, headers: { location: '/b.png' } })
        : respond(TEST_PNG),
    );
    vi.stubGlobal('fetch', hops);
    expect((await t.owner.post(`/v1/menus/${menu.id}/image-from-url`, { url })).status).toBe(200);
    expect(String(hops.mock.calls[1]![0])).toBe('https://imgbp.salonboard.com/b.png');
    expect((await menusOf(t))[0]!.imageFileId).not.toBeNull();
  });

  it('needs menu.manage', async () => {
    const t = await createTenant();
    const menu = await createMenu(t, { shopId: t.shopId, name: 'カット' });
    const stylist = await createStaffUser(t, 'stylist');
    const fetchMock = vi.fn(async () => respond(TEST_PNG));
    vi.stubGlobal('fetch', fetchMock);
    expect(
      (
        await stylist.api.post(`/v1/menus/${menu.id}/image-from-url`, {
          url: 'https://imgbp.salonboard.com/a.png',
        })
      ).status,
    ).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
