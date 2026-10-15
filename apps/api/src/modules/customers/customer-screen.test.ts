import { describe, expect, it } from 'vitest';
import { asSystem, createCustomer, createMenu, createStaffUser, createTenant, jst, nextWeekday, type Tenant } from '../../test/helpers.js';
import { resolveCustomer } from './identity.js';

const WED = 3;

async function completedVisit(t: Tenant, opts: { customerId: string; staffId: string; menuId: string; date: string; time: string; isNominated?: boolean }) {
  const a = await t.owner.post('/v1/appointments', {
    shopId: t.shopId,
    customerId: opts.customerId,
    staffId: opts.staffId,
    startAt: jst(opts.date, opts.time),
    menuIds: [opts.menuId],
    isNominated: opts.isNominated ?? false,
  });
  if (a.status !== 201) throw new Error(`appointment failed: ${JSON.stringify(a.body)}`);
  for (const step of ['check-in', 'start', 'complete']) {
    const r = await t.owner.post(`/v1/appointments/${a.body.id}/${step}`);
    if (r.status !== 200) throw new Error(`${step} failed: ${JSON.stringify(r.body)}`);
  }
  return a.body as { id: string };
}

describe('customer screen: memo, LINE display name, overview', () => {
  it('keeps the profile memo on create / update and clears it with an empty value', async () => {
    const t = await createTenant();
    const created = await t.owner.post('/v1/customers', { lastName: '山田', firstName: '花子', memo: '  カラーはアレルギー注意  ' });
    expect(created.status).toBe(201);
    expect(created.body.customer.memo).toBe('カラーはアレルギー注意');
    const id = created.body.customer.id;
    // a PATCH without memo leaves it alone
    expect((await t.owner.patch(`/v1/customers/${id}`, { occupation: '会社員' })).body.memo).toBe('カラーはアレルギー注意');
    expect((await t.owner.patch(`/v1/customers/${id}`, { memo: '次回は午前希望' })).body.memo).toBe('次回は午前希望');
    expect((await t.owner.patch(`/v1/customers/${id}`, { memo: null })).body.memo).toBeNull();
    expect((await t.owner.patch(`/v1/customers/${id}`, { memo: 'x'.repeat(5001) })).status).toBe(400);
  });

  it('marks records that still carry the LINE display name instead of a real name', async () => {
    const t = await createTenant();
    const r = await asSystem(t.organizationId, (ctx) =>
      resolveCustomer(ctx, { provider: 'line', providerAccountId: 'ch1', externalId: 'Uabc', displayName: 'はなちゃん', profile: { pictureUrl: 'https://profile.example/p.jpg' }, shopId: t.shopId }),
    );
    const named = await createCustomer(t, { lastName: '本名', firstName: 'あり' });

    const list = await t.owner.get('/v1/customers');
    const byId = new Map((list.body.items as { id: string; name_source: string | null; has_line: boolean }[]).map((c) => [c.id, c]));
    expect(byId.get(r.customerId)).toMatchObject({ name_source: 'line', has_line: true });
    expect(byId.get(named.id)).toMatchObject({ name_source: null, has_line: false });
    expect((await t.owner.get(`/v1/customers/${r.customerId}`)).body.name_source).toBe('line');

    const overview = await t.owner.get(`/v1/customers/${r.customerId}/overview`);
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({
      name_source: 'line',
      member_no: null,
      line: { display_name: 'はなちゃん', picture_url: 'https://profile.example/p.jpg' },
      assigned_staff: [],
      linked_customers: [],
    });

    // once staff register the real name the mark goes away
    await t.owner.patch(`/v1/customers/${r.customerId}`, { lastName: '田中', firstName: '花' });
    expect((await t.owner.get(`/v1/customers/${r.customerId}`)).body.name_source).toBeNull();
    expect((await t.owner.get(`/v1/customers/${r.customerId}/overview`)).body.name_source).toBeNull();
  });

  it('derives the staff in charge from completed reservations (nominated first, working staff only)', async () => {
    const t = await createTenant();
    const a = await createStaffUser(t, 'stylist', { displayName: '指名 太郎' });
    const b = await createStaffUser(t, 'stylist', { displayName: '直近 次郎' });
    const menu = await createMenu(t);
    const customer = await createCustomer(t);
    const date = nextWeekday(WED);

    // no completed visit: nobody, and the customer is listed as 担当未設定
    expect((await t.owner.get(`/v1/customers/${customer.id}/overview`)).body.assigned_staff).toEqual([]);
    expect((await t.owner.get('/v1/customers?unassigned=true')).body.total).toBe(1);

    await completedVisit(t, { customerId: customer.id, staffId: a.staffId, menuId: menu.id, date, time: '10:00', isNominated: true });
    await completedVisit(t, { customerId: customer.id, staffId: a.staffId, menuId: menu.id, date, time: '12:00' });
    await completedVisit(t, { customerId: customer.id, staffId: b.staffId, menuId: menu.id, date, time: '14:00' });

    const overview = (await t.owner.get(`/v1/customers/${customer.id}/overview`)).body;
    expect(overview.assigned_staff).toEqual([
      { staff_id: a.staffId, staff_name: '指名 太郎', is_primary: true, visit_count: 2 },
      { staff_id: b.staffId, staff_name: '直近 次郎', is_primary: false, visit_count: 1 },
    ]);
    // the list follows: the customer is no longer 担当未設定 (staff of the first completed visit, never replaced automatically)
    expect((await t.owner.get('/v1/customers?unassigned=true')).body.total).toBe(0);
    const row = (await t.owner.get(`/v1/customers?staffId=${a.staffId}`)).body.items[0];
    expect(row).toMatchObject({ id: customer.id, primary_staff_name: '指名 太郎' });

    // the reservation history of the customer screen: newest first, as many as asked for
    const visits = await t.owner.get(`/v1/customers/${customer.id}/visits`, { limit: 2 });
    expect(visits.body.map((v: { staff_name: string; status: string }) => [v.staff_name, v.status])).toEqual([
      ['直近 次郎', 'completed'],
      ['指名 太郎', 'completed'],
    ]);
    expect((await t.owner.get(`/v1/customers/${customer.id}/visits`)).body).toHaveLength(3);
    expect((await t.owner.get(`/v1/customers/${customer.id}/visits`, { limit: 501 })).status).toBe(400);

    // a staff member who left no longer counts
    await asSystem(t.organizationId, (ctx) => ctx.trx.updateTable('staffs').set({ status: 'retired' }).where('id', '=', a.staffId).execute());
    expect((await t.owner.get(`/v1/customers/${customer.id}/overview`)).body.assigned_staff).toEqual([
      { staff_id: b.staffId, staff_name: '直近 次郎', is_primary: true, visit_count: 1 },
    ]);

    // without visits the staff member set on the record is shown
    const manual = await createCustomer(t, { primaryStaffId: b.staffId });
    expect((await t.owner.get(`/v1/customers/${manual.id}/overview`)).body.assigned_staff).toEqual([
      { staff_id: b.staffId, staff_name: '直近 次郎', is_primary: true, visit_count: 0 },
    ]);
    // other organizations cannot read it
    const other = await createTenant();
    expect((await other.owner.get(`/v1/customers/${customer.id}/overview`)).status).toBe(404);
  });
});

describe('name duplicates (名前重複)', () => {
  it('groups records with the same normalized name; merge, link under one 会員番号, dismiss', async () => {
    const t = await createTenant();
    const keep = (await t.owner.post('/v1/customers', { lastName: '山田', firstName: '花子', lastNameKana: 'ヤマダ', firstNameKana: 'ハナコ', phone: '090-1111-2222', customerNumber: 'A-001' })).body.customer;
    const dup1 = (await t.owner.post('/v1/customers', { lastName: '山田　', firstName: ' 花子' })).body.customer; // full-width / stray spaces
    const dup2 = (await t.owner.post('/v1/customers', { lastName: '山田花子' })).body.customer; // typed into one field
    const sato1 = (await t.owner.post('/v1/customers', { lastName: '佐藤', firstName: '愛', phone: '080-3333-4444' })).body.customer;
    const sato2 = (await t.owner.post('/v1/customers', { lastName: '佐藤', firstName: '愛' })).body.customer;
    await createCustomer(t, { lastName: '単独', firstName: '太郎' });

    const list = await t.owner.get('/v1/customers/name-duplicates');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    const yamada = list.body.groups[0]; // larger group first
    expect(yamada.customers.map((c: { id: string }) => c.id).sort()).toEqual([keep.id, dup1.id, dup2.id].sort());
    // the record with a phone number comes first (recommended to keep) and shows its number
    expect(yamada.customers[0]).toMatchObject({ id: keep.id, name: '山田 花子', name_kana: 'ヤマダ ハナコ', phone: '090-1111-2222', member_no: 'A-001', visit_count: 0 });
    expect(yamada.customers[0].store_name).toContain('本店');
    expect(list.body.groups[1].customers.map((c: { id: string }) => c.id)).toEqual([sato1.id, sato2.id]);

    // search narrows the groups (name or phone), paging keeps the total
    const byName = await t.owner.get('/v1/customers/name-duplicates', { search: 'やまだ' });
    expect(byName.body.total).toBe(1);
    expect(byName.body.groups[0].normalized_name).toBe(yamada.normalized_name);
    expect((await t.owner.get('/v1/customers/name-duplicates', { search: '080-3333' })).body.groups[0].customers[0].id).toBe(sato1.id);
    const page2 = await t.owner.get('/v1/customers/name-duplicates', { limit: 1, offset: 1 });
    expect(page2.body.total).toBe(2);
    expect(page2.body.groups).toHaveLength(1);
    expect(page2.body.groups[0].normalized_name).toBe(list.body.groups[1].normalized_name);

    // 統合: the duplicate goes into the kept record and leaves the group
    expect((await t.owner.post(`/v1/customers/${keep.id}/merge`, { sourceCustomerId: dup2.id })).status).toBe(200);
    const afterMerge = await t.owner.get('/v1/customers/name-duplicates', { search: '山田' });
    expect(afterMerge.body.groups[0].customers.map((c: { id: string }) => c.id)).toEqual([keep.id, dup1.id]);

    // 同一人物としてリンク: both records carry one number and the group is settled
    const linked = await t.owner.post('/v1/customers/link-master', { customerIds: [keep.id, dup1.id] });
    expect(linked.status).toBe(200);
    expect(linked.body.member_no).toBe('A-001');
    expect((await t.owner.get('/v1/customers/name-duplicates')).body.total).toBe(1);
    const overview = (await t.owner.get(`/v1/customers/${dup1.id}/overview`)).body;
    expect(overview.member_no).toBe('A-001');
    expect(overview.linked_customers).toHaveLength(1);
    expect(overview.linked_customers[0]).toMatchObject({ id: keep.id, visit_count: 0, last_visit_at: null, last_reservation_at: null });
    expect(overview.linked_customers[0].store_name).toContain('本店');
    // unlinking the last pair dissolves the group; it is a name duplicate again
    expect((await t.owner.post(`/v1/customers/${dup1.id}/unlink-master`)).body).toEqual({ unlinked: 2 });
    expect((await t.owner.get(`/v1/customers/${keep.id}/overview`)).body.linked_customers).toEqual([]);
    expect((await t.owner.get('/v1/customers/name-duplicates')).body.total).toBe(2);

    // 統合しない: dismissed until a new record with the same name appears
    const satoName = list.body.groups[1].normalized_name;
    expect((await t.owner.post('/v1/customers/name-duplicates/dismiss', { normalizedName: satoName })).body).toEqual({ dismissed: 2 });
    expect((await t.owner.get('/v1/customers/name-duplicates')).body.groups.map((g: { normalized_name: string }) => g.normalized_name)).toEqual([yamada.normalized_name]);
    expect((await t.owner.post('/v1/customers/name-duplicates/dismiss', { normalizedName: 'いない名前' })).status).toBe(404);
    const sato3 = (await t.owner.post('/v1/customers', { lastName: '佐藤', firstName: '愛' })).body.customer;
    const again = await t.owner.get('/v1/customers/name-duplicates', { search: '佐藤' });
    expect(again.body.groups[0].customers.map((c: { id: string }) => c.id)).toContain(sato3.id);
    expect(again.body.groups[0].customers).toHaveLength(3);
  });

  it('issues a new 会員番号 when no record has a number, and needs the merge permission', async () => {
    const t = await createTenant();
    const a = (await t.owner.post('/v1/customers', { lastName: '鈴木', firstName: '一郎' })).body.customer;
    const b = (await t.owner.post('/v1/customers', { lastName: '鈴木', firstName: '一郎' })).body.customer;
    const linked = await t.owner.post('/v1/customers/link-master', { customerIds: [a.id, b.id] });
    expect(linked.body.member_no).toMatch(/^M\d{8}$/);
    // linking again keeps the number; a third record joins the same number
    const c = (await t.owner.post('/v1/customers', { lastName: '鈴木', firstName: '一郎' })).body.customer;
    expect((await t.owner.post('/v1/customers/link-master', { customerIds: [c.id, a.id] })).body.member_no).toBe(linked.body.member_no);
    expect((await t.owner.get(`/v1/customers/${a.id}/overview`)).body.linked_customers.map((x: { id: string }) => x.id).sort()).toEqual([b.id, c.id].sort());
    expect((await t.owner.post('/v1/customers/link-master', { customerIds: [a.id, a.id] })).status).toBe(400);

    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.get('/v1/customers/name-duplicates')).status).toBe(403);
    expect((await stylist.api.post('/v1/customers/link-master', { customerIds: [a.id, b.id] })).status).toBe(403);
    expect((await stylist.api.post('/v1/customers/name-duplicates/dismiss', { normalizedName: '鈴木一郎' })).status).toBe(403);
    expect((await stylist.api.post(`/v1/customers/${a.id}/unlink-master`)).status).toBe(403);

    // another organization neither sees the groups nor can link these records
    const other = await createTenant();
    expect((await other.owner.get('/v1/customers/name-duplicates')).body.total).toBe(0);
    expect((await other.owner.post('/v1/customers/link-master', { customerIds: [a.id, b.id] })).status).toBe(404);
  });

  it('limits the groups to the shops of staff who cannot see every customer', async () => {
    const t = await createTenant();
    const shop2 = (await t.owner.post('/v1/shops', { name: '2号店', slug: `s2-${Date.now()}` })).body;
    const manager = await createStaffUser(t, 'manager', { shopIds: [t.shopId] });
    await t.owner.post('/v1/customers', { lastName: '高橋', firstName: '恵', primaryShopId: t.shopId });
    await t.owner.post('/v1/customers', { lastName: '高橋', firstName: '恵', primaryShopId: shop2.id });
    expect((await t.owner.get('/v1/customers/name-duplicates')).body.total).toBe(1);
    // the manager only sees one of the two records, so there is no group for them
    expect((await manager.api.get('/v1/customers/name-duplicates')).body.total).toBe(0);
    await t.owner.post('/v1/customers', { lastName: '高橋', firstName: '恵', primaryShopId: t.shopId });
    const mine = await manager.api.get('/v1/customers/name-duplicates');
    expect(mine.body.total).toBe(1);
    expect(mine.body.groups[0].customers).toHaveLength(2);
  });
});

describe('duplicate pairs for the 統合候補 list', () => {
  it('tells which side came from LINE and who is in charge', async () => {
    const t = await createTenant();
    const existing = (await t.owner.post('/v1/customers', { lastName: '既存', firstName: '花子', phone: '090-5555-6666', primaryStaffId: t.ownerStaffId })).body.customer;
    const line = await asSystem(t.organizationId, (ctx) =>
      resolveCustomer(ctx, { provider: 'line', providerAccountId: 'ch1', externalId: 'Uline', displayName: 'hana', profile: { pictureUrl: 'https://profile.example/h.jpg' }, shopId: t.shopId }),
    );
    // the LINE friend typed the same phone number later (e.g. booking form) → exact pair
    await t.owner.patch(`/v1/customers/${line.customerId}`, { phone: '090-5555-6666' });
    const pairs = (await t.owner.get('/v1/customers/duplicates')).body as { a: Record<string, any>; b: Record<string, any>; reasons: string[] }[];
    expect(pairs).toHaveLength(1);
    const sides = [pairs[0]!.a, pairs[0]!.b];
    const lineSide = sides.find((s) => s.id === line.customerId)!;
    const existingSide = sides.find((s) => s.id === existing.id)!;
    expect(lineSide.line).toEqual({ display_name: 'hana', picture_url: 'https://profile.example/h.jpg' });
    expect(existingSide.line).toBeNull();
    expect(existingSide.primary_staff_name).toBe('オーナー 太郎');
    expect(typeof existingSide.created_at).toBe('string');
    expect(pairs[0]!.reasons).toEqual(['phone_exact']);
  });
});
