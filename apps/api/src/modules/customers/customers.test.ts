import { describe, expect, it } from 'vitest';
import { asSystem, createStaffUser, createTenant, insertAppointment } from '../../test/helpers.js';
import { resolveCustomer } from './identity.js';

describe('customers', () => {
  it('creates, searches (kana / phone), updates with audit, and paginates', async () => {
    const t = await createTenant();
    const created = await t.owner.post('/v1/customers', {
      lastName: '山田',
      firstName: '花子',
      lastNameKana: 'ヤマダ',
      firstNameKana: 'ハナコ',
      phone: '090-1234-5678',
      email: 'Hanako@Example.com',
      birthday: '1990-04-01',
    });
    expect(created.status).toBe(201);
    expect(created.body.customer.display_name).toBe('山田 花子');
    expect(created.body.customer.email).toBe('hanako@example.com');
    expect(created.body.customer.primary_shop_id).toBe(t.shopId);
    const id = created.body.customer.id;

    for (const q of ['ヤマダ', '山田花子', '09012345678', '+819012345678']) {
      const res = await t.owner.get('/v1/customers', { q });
      expect(res.body.items.map((c: { id: string }) => c.id), q).toContain(id);
    }

    const upd = await t.owner.patch(`/v1/customers/${id}`, { occupation: '会社員' });
    expect(upd.body.occupation).toBe('会社員');
    const logs = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('audit_logs').select(['action', 'after']).where('resource_id', '=', id).orderBy('id').execute(),
    );
    expect(logs.map((l) => l.action)).toEqual(['customer.create', 'customer.update']);
    expect(logs[1]!.after).toEqual({ occupation: '会社員' });

    // pagination
    for (let i = 0; i < 5; i++) await t.owner.post('/v1/customers', { lastName: `テスト${i}`, lastNameKana: `テスト${i}` });
    const p1 = await t.owner.get('/v1/customers', { limit: 3, sort: 'created' });
    expect(p1.body.items).toHaveLength(3);
    const p2 = await t.owner.get('/v1/customers', { limit: 3, sort: 'created', cursor: p1.body.nextCursor });
    expect(p2.body.items).toHaveLength(3);
    expect(new Set([...p1.body.items, ...p2.body.items].map((c: { id: string }) => c.id)).size).toBe(6);
  });

  it('lists customers with no staff in charge (担当未設定)', async () => {
    const t = await createTenant();
    const assigned = (await t.owner.post('/v1/customers', { lastName: '担当', firstName: 'あり', primaryStaffId: t.ownerStaffId })).body.customer;
    const free = (await t.owner.post('/v1/customers', { lastName: '担当', firstName: 'なし' })).body.customer;
    const unassigned = await t.owner.get('/v1/customers?unassigned=true');
    expect(unassigned.body.items.map((c: { id: string }) => c.id)).toEqual([free.id]);
    const mine = await t.owner.get(`/v1/customers?staffId=${t.ownerStaffId}`);
    expect(mine.body.items.map((c: { id: string }) => c.id)).toEqual([assigned.id]);
    expect((await t.owner.get('/v1/customers')).body.items).toHaveLength(2);

    // totals follow the filters (not the page size), and each row names the staff in charge
    expect(unassigned.body.total).toBe(1);
    const firstPage = await t.owner.get('/v1/customers?limit=1');
    expect(firstPage.body.items).toHaveLength(1);
    expect(firstPage.body.total).toBe(2);
    expect((await t.owner.get(`/v1/customers?limit=1&cursor=${firstPage.body.nextCursor}`)).body.total).toBe(2);
    expect(mine.body.items[0]).toMatchObject({ has_line: false });
    expect(typeof mine.body.items[0].primary_staff_name).toBe('string');
    expect(unassigned.body.items[0].primary_staff_name).toBeNull();
  });

  it('lists the customers of one shop: registered there, related to it, or booked there (カルテ / 受付の紐付け)', async () => {
    const t = await createTenant();
    const shop2 = (await t.owner.post('/v1/shops', { name: '2号店', slug: `s2-${Date.now()}` })).body;
    const registered = (await t.owner.post('/v1/customers', { lastName: '本店', firstName: '登録', primaryShopId: t.shopId })).body.customer;
    const elsewhere = (await t.owner.post('/v1/customers', { lastName: '二号店', firstName: '登録', primaryShopId: shop2.id })).body.customer;
    const booked = (await t.owner.post('/v1/customers', { lastName: '二号店', firstName: '予約', primaryShopId: shop2.id })).body.customer;
    await insertAppointment(t.organizationId, { shopId: t.shopId, customerId: booked.id, startAt: new Date(Date.now() - 86_400_000), status: 'cancelled' });
    const visited = (await t.owner.post('/v1/customers', { lastName: '二号店', firstName: '来店', primaryShopId: shop2.id })).body.customer;
    await asSystem(t.organizationId, (ctx) =>
      ctx.trx.insertInto('customer_shop_relations').values({ organization_id: t.organizationId, customer_id: visited.id, shop_id: t.shopId, relation_type: 'visited' }).execute(),
    );
    // a deleted booking does not make the customer one of the shop's
    const removed = (await t.owner.post('/v1/customers', { lastName: '二号店', firstName: '削除', primaryShopId: shop2.id })).body.customer;
    const gone = await insertAppointment(t.organizationId, { shopId: t.shopId, customerId: removed.id, startAt: new Date(Date.now() - 86_400_000) });
    await asSystem(t.organizationId, (ctx) => ctx.trx.updateTable('appointments').set({ deleted_at: new Date() }).where('id', '=', gone.id).execute());

    const ids = async (qs: string) => ((await t.owner.get(`/v1/customers?${qs}`)).body.items as { id: string }[]).map((c) => c.id).sort();
    expect(await ids(`shopId=${t.shopId}`)).toEqual([registered.id, booked.id, visited.id].sort());
    expect(await ids(`shopId=${shop2.id}`)).toEqual([elsewhere.id, booked.id, visited.id, removed.id].sort());
    // the reception's link dialog searches the shop's customers by name
    expect(await ids(`shopId=${t.shopId}&q=${encodeURIComponent('二号店')}&limit=20`)).toEqual([booked.id, visited.id].sort());
    const page = await t.owner.get(`/v1/customers?shopId=${t.shopId}&limit=1000`);
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(3);
    expect((await t.owner.get('/v1/customers?limit=1001')).status).toBe(400);
  });

  it('shows the shared 会員番号 on list rows', async () => {
    const t = await createTenant();
    const a = (await t.owner.post('/v1/customers', { lastName: '会員', firstName: '一' })).body.customer;
    const b = (await t.owner.post('/v1/customers', { lastName: '会員', firstName: '一' })).body.customer;
    const linked = await t.owner.post('/v1/customers/link-master', { customerIds: [a.id, b.id] });
    expect(linked.status).toBe(200);
    const rows = (await t.owner.get(`/v1/customers?q=${encodeURIComponent('会員')}`)).body.items as { id: string; member_no: string | null }[];
    expect(rows.map((r) => r.member_no)).toEqual([linked.body.member_no, linked.body.member_no]);
  });

  it('audits customer detail views', async () => {
    const t = await createTenant();
    const c = (await t.owner.post('/v1/customers', { lastName: '閲覧' })).body.customer;
    await t.owner.get(`/v1/customers/${c.id}`);
    const views = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('audit_logs').select('action').where('resource_id', '=', c.id).where('action', '=', 'customer.view').execute(),
    );
    expect(views).toHaveLength(1);
  });

  it('limits visibility to assigned shops unless granted cross-shop access', async () => {
    const t = await createTenant();
    const shop2 = (await t.owner.post('/v1/shops', { name: '2号店', slug: `v2-${Date.now()}` })).body;
    const inShop2 = (await t.owner.post('/v1/customers', { lastName: '二号店客', primaryShopId: shop2.id })).body.customer;
    const stylist = await createStaffUser(t, 'stylist'); // assigned to main shop only
    const list = await stylist.api.get('/v1/customers');
    expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain(inShop2.id);
    const detail = await stylist.api.get(`/v1/customers/${inShop2.id}`);
    expect(detail.status).toBe(404);
  });

  it('keeps private memos visible only to their author (even owners cannot read)', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    const c = (await t.owner.post('/v1/customers', { lastName: 'メモ' })).body.customer;
    await stylist.api.post(`/v1/customers/${c.id}/memos`, { body: '個人的な引継ぎ', visibility: 'private' });
    await stylist.api.post(`/v1/customers/${c.id}/memos`, { body: '共有メモ', visibility: 'shared' });
    const own = await stylist.api.get(`/v1/customers/${c.id}/memos`);
    expect(own.body).toHaveLength(2);
    const ownerView = await t.owner.get(`/v1/customers/${c.id}/memos`);
    expect(ownerView.body.map((m: { body: string }) => m.body)).toEqual(['共有メモ']);
  });

  it('detects duplicates with exact and similarity rules', async () => {
    const t = await createTenant();
    const a = (await t.owner.post('/v1/customers', { lastName: '佐藤', firstName: '美咲', lastNameKana: 'サトウ', firstNameKana: 'ミサキ', phone: '08011112222', birthday: '1995-01-01' })).body;
    const b = await t.owner.post('/v1/customers', { lastName: '佐藤', firstName: 'みさき', lastNameKana: 'さとう', firstNameKana: 'みさき', birthday: '1995-01-01' });
    expect(b.body.duplicateCandidates[0].customerId).toBe(a.customer.id);
    expect(b.body.duplicateCandidates[0].strength).toBe('similar');
    const c = await t.owner.post('/v1/customers', { lastName: '別人', phone: '080-1111-2222' });
    expect(c.body.duplicateCandidates[0]).toMatchObject({ customerId: a.customer.id, strength: 'exact', reasons: ['phone_exact'] });
    const pairs = await t.owner.get('/v1/customers/duplicates');
    expect(pairs.body.length).toBeGreaterThanOrEqual(2);
  });

  it('merges customers, relinks records, and supports undo', async () => {
    const t = await createTenant();
    const tag = (await t.owner.post('/v1/tags', { name: 'VIP' })).body;
    const target = (await t.owner.post('/v1/customers', { lastName: '統合先', phone: '07000000001' })).body.customer;
    const source = (await t.owner.post('/v1/customers', { lastName: '統合元', email: 'src@example.com', birthday: '2000-02-02', tagIds: [tag.id] })).body.customer;
    await t.owner.post(`/v1/customers/${source.id}/memos`, { body: 'source memo', visibility: 'shared' });

    const merged = await t.owner.post(`/v1/customers/${target.id}/merge`, { sourceCustomerId: source.id, reason: '同一人物' });
    expect(merged.status).toBe(200);
    expect(merged.body.moved.customer_memos).toBe(1);

    const tgt = (await t.owner.get(`/v1/customers/${target.id}`)).body;
    expect(tgt.email).toBe('src@example.com');
    expect(tgt.birthday).toBe('2000-02-02');
    expect(tgt.tags.map((x: { name: string }) => x.name)).toEqual(['VIP']);
    const memos = (await t.owner.get(`/v1/customers/${target.id}/memos`)).body;
    expect(memos).toHaveLength(1);
    const src = (await t.owner.get(`/v1/customers/${source.id}`)).body;
    expect(src.status).toBe('merged');
    expect(src.merged_into_id).toBe(target.id);
    // merged customers are hidden from search
    const search = await t.owner.get('/v1/customers', { q: '統合元' });
    expect(search.body.items).toHaveLength(0);

    const undo = await t.owner.post(`/v1/customer-merges/${merged.body.mergeLogId}/undo`);
    expect(undo.status).toBe(200);
    const restored = (await t.owner.get(`/v1/customers/${source.id}`)).body;
    expect(restored.status).toBe('active');
    expect(restored.tags.map((x: { name: string }) => x.name)).toEqual(['VIP']);
    const tgtAfter = (await t.owner.get(`/v1/customers/${target.id}`)).body;
    expect(tgtAfter.email).toBeNull();
    expect(tgtAfter.tags).toHaveLength(0);
    expect((await t.owner.get(`/v1/customers/${source.id}/memos`)).body).toHaveLength(1);
  });

  it('resolves identities: links by strong uniqueness only', async () => {
    const t = await createTenant();
    const existing = (await t.owner.post('/v1/customers', { lastName: '既存', phone: '09099998888' })).body.customer;
    const r1 = await asSystem(t.organizationId, (ctx) =>
      resolveCustomer(ctx, { provider: 'line', providerAccountId: 'ch1', externalId: 'U123', displayName: 'LINE名', phone: '090-9999-8888', shopId: t.shopId }),
    );
    expect(r1).toMatchObject({ customerId: existing.id, matchedBy: 'phone', created: false });
    const r2 = await asSystem(t.organizationId, (ctx) => resolveCustomer(ctx, { provider: 'line', providerAccountId: 'ch1', externalId: 'U123' }));
    expect(r2).toMatchObject({ customerId: existing.id, matchedBy: 'identity' });
    const r3 = await asSystem(t.organizationId, (ctx) => resolveCustomer(ctx, { provider: 'line', providerAccountId: 'ch1', externalId: 'U999', displayName: '新規' }));
    expect(r3.created).toBe(true);
  });

  it('exports CSV with formula injection protection and audit', async () => {
    const t = await createTenant();
    await t.owner.post('/v1/customers', { lastName: '=HYPERLINK("x")', firstName: '太郎' });
    const res = await t.owner.get('/v1/customers/export.csv');
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain(`"'=HYPERLINK(""x"")"`);
    const stylist = await createStaffUser(t, 'stylist');
    const denied = await stylist.api.get('/v1/customers/export.csv');
    expect(denied.status).toBe(403);
  });
});

describe('customer search refinements', () => {
  it('finds customers by partial phone (prefix / last 4 digits)', async () => {
    const t = await createTenant();
    const c = (await t.owner.post('/v1/customers', { lastName: '部分', phone: '090-2468-1357' })).body.customer;
    for (const q of ['1357', '090-2468', '0902468']) {
      const res = await t.owner.get('/v1/customers', { q });
      expect(res.body.items.map((x: { id: string }) => x.id), q).toContain(c.id);
    }
  });
});
