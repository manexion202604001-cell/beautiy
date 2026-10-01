import { describe, expect, it } from 'vitest';
import { asSystem, createStaffUser, createTenant } from '../../test/helpers.js';
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
