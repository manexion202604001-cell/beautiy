import { describe, expect, it } from 'vitest';
import { api, asSystem, createCustomer, createStaffUser, createTenant, uploadTestFile, type Tenant } from '../../test/helpers.js';
import { mergeIntoCounselingSheet } from './api.js';

async function templateByName(t: Tenant, name: string) {
  const res = await t.owner.get('/v1/karte-templates');
  const tpl = (res.body as { id: string; name: string }[]).find((x) => x.name === name);
  if (!tpl) throw new Error(`template ${name} not seeded`);
  return tpl;
}

describe('counselling sheet (カウンセリングシート)', () => {
  it('is saved per customer, edited in place, validated and audited', async () => {
    const t = await createTenant();
    const c = await createCustomer(t);
    const url = `/v1/customers/${c.id}/counseling-sheet`;
    expect((await t.owner.get(url)).body).toEqual({ counseling_sheet: null });

    const data = { hair: { hair_volume: '75', hair_curl: 'あり', hair_curl_type: ['生え癖', '髪癖'] }, nail: { allergy: 'はい', allergy_detail: 'ジェル' } };
    const saved = await t.owner.put(url, { data, shopId: t.shopId });
    expect(saved.status).toBe(200);
    expect(saved.body.counseling_sheet).toMatchObject({ customer_id: c.id, shop_id: t.shopId, data });

    // saving again edits the same sheet
    const next = { ...data, hair: { hair_volume: '25' } };
    const again = await t.owner.put(url, { data: next });
    expect(again.body.counseling_sheet.id).toBe(saved.body.counseling_sheet.id);
    expect((await t.owner.get(url)).body.counseling_sheet.data).toEqual(next);
    const rows = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('customer_counseling_sheets').select('id').where('customer_id', '=', c.id).execute());
    expect(rows).toHaveLength(1);

    // malformed sheets are refused
    expect((await t.owner.put(url, { data: { 'Bad Key': { a: 'x' } } })).status).toBe(400);
    expect((await t.owner.put(url, { data: { hair: { hair_volume: 5 } } })).status).toBe(400);
    expect((await t.owner.put(url, { data: { hair: { memo: 'x'.repeat(2001) } } })).status).toBe(400);

    const logs = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('audit_logs').select('action').where('resource_id', '=', c.id).where('action', 'like', 'counseling_sheet.%').orderBy('id').execute(),
    );
    expect(logs.map((l) => l.action)).toEqual(['counseling_sheet.save', 'counseling_sheet.save', 'counseling_sheet.view']);
  });

  it('needs karte permissions and stays inside the organization', async () => {
    const t = await createTenant();
    const c = await createCustomer(t);
    const url = `/v1/customers/${c.id}/counseling-sheet`;
    await t.owner.put(url, { data: { body: { diet: '規則正しい' } } });

    const reception = await createStaffUser(t, 'reception'); // no karte.read / karte.write
    expect((await reception.api.get(url)).status).toBe(403);
    expect((await reception.api.put(url, { data: {} })).status).toBe(403);
    const assistant = await createStaffUser(t, 'assistant'); // karte.read + karte.write
    expect((await assistant.api.get(url)).body.counseling_sheet.data).toEqual({ body: { diet: '規則正しい' } });
    expect((await assistant.api.put(url, { data: { body: { diet: '不規則' } } })).status).toBe(200);

    const other = await createTenant();
    expect((await other.owner.get(url)).status).toBe(404);
    expect((await other.owner.put(url, { data: {} })).status).toBe(404);
    expect((await api().get(url)).status).toBe(401);
  });

  it('follows a customer merge (and its undo), and takes answers from other modules by category', async () => {
    const t = await createTenant();
    const target = await createCustomer(t, { lastName: '統合先' });
    const source = await createCustomer(t, { lastName: '統合元', memo: '統合元のメモ' });
    await t.owner.put(`/v1/customers/${source.id}/counseling-sheet`, { data: { eyebrow: { patch_test: '希望' } } });

    const merged = await t.owner.post(`/v1/customers/${target.id}/merge`, { sourceCustomerId: source.id });
    expect(merged.body.moved.customer_counseling_sheets).toBe(1);
    expect((await t.owner.get(`/v1/customers/${target.id}/counseling-sheet`)).body.counseling_sheet.data).toEqual({ eyebrow: { patch_test: '希望' } });
    // the empty memo of the kept record is filled from the merged one
    expect((await t.owner.get(`/v1/customers/${target.id}`)).body.memo).toBe('統合元のメモ');

    await t.owner.post(`/v1/customer-merges/${merged.body.mergeLogId}/undo`);
    expect((await t.owner.get(`/v1/customers/${target.id}/counseling-sheet`)).body.counseling_sheet).toBeNull();
    expect((await t.owner.get(`/v1/customers/${source.id}/counseling-sheet`)).body.counseling_sheet.data).toEqual({ eyebrow: { patch_test: '希望' } });
    expect((await t.owner.get(`/v1/customers/${target.id}`)).body.memo).toBeNull();

    // answers collected elsewhere replace their own categories only
    await asSystem(t.organizationId, (ctx) => mergeIntoCounselingSheet(ctx, source.id, { nail: { nail_experience: 'はい' }, eyebrow: { patch_test: '希望なし' } }, t.shopId));
    expect((await t.owner.get(`/v1/customers/${source.id}/counseling-sheet`)).body.counseling_sheet.data).toEqual({
      eyebrow: { patch_test: '希望なし' },
      nail: { nail_experience: 'はい' },
    });
  });
});

describe('karte: fixed treatment record and face drawing', () => {
  it('accepts the fixed fields on any karte and shares them (never the internal note)', async () => {
    const t = await createTenant();
    const c = await createCustomer(t);
    const cut = await templateByName(t, 'カット');
    const standard = { menu_content: 'カット＋カラー', color_formula: '8AB:6N = 1:1 + 6%OX', next_suggestion: '次回はトリートメント' };

    // template karte: the fixed fields are accepted next to the template's own fields, other unknown keys are not
    const withTemplate = await t.owner.post('/v1/kartes', { customerId: c.id, shopId: t.shopId, templateId: cut.id, fields: { style_name: 'ボブ', ...standard }, note: '内部メモ' });
    expect(withTemplate.status).toBe(201);
    expect(withTemplate.body.fields).toMatchObject({ style_name: 'ボブ', ...standard });
    expect((await t.owner.post('/v1/kartes', { customerId: c.id, shopId: t.shopId, templateId: cut.id, fields: { style_name: 'ボブ', secret: 'x' } })).status).toBe(400);
    const patched = await t.owner.patch(`/v1/kartes/${withTemplate.body.id}`, { version: 1, fields: { style_name: 'ボブ', ...standard, hair_condition: 'ダメージ中' } });
    expect(patched.status).toBe(200);
    expect(patched.body.fields.hair_condition).toBe('ダメージ中');

    // template-less karte made on the customer screen
    const plain = (await t.owner.post('/v1/kartes', { customerId: c.id, shopId: t.shopId, fields: standard, note: '社内だけ' })).body;
    const share = await t.owner.post(`/v1/kartes/${plain.id}/share`, {});
    const view = await api().get(`/v1/public/karte-shares/${share.body.url.split('/').pop()}`);
    expect(view.status).toBe(200);
    expect(view.body.fields.map((f: { label: string; display: string }) => [f.label, f.display])).toEqual([
      ['メニュー', 'カット＋カラー'],
      ['カラー配合', '8AB:6N = 1:1 + 6%OX'],
      ['次回提案', '次回はトリートメント'],
    ]);
    expect(JSON.stringify(view.body)).not.toContain('社内だけ');
  });

  it('keeps one live face drawing per karte', async () => {
    const t = await createTenant();
    const c = await createCustomer(t);
    const k = (await t.owner.post('/v1/kartes', { customerId: c.id, shopId: t.shopId, fields: {} })).body;
    const first = await uploadTestFile(t.owner, { purpose: 'sketch' });
    const a1 = await t.owner.post(`/v1/kartes/${k.id}/assets`, { fileId: first.fileId, assetType: 'face_drawing' });
    expect(a1.status).toBe(201);
    expect(a1.body.asset_type).toBe('face_drawing');
    const second = await uploadTestFile(t.owner, { purpose: 'sketch' });
    const a2 = await t.owner.post(`/v1/kartes/${k.id}/assets`, { fileId: second.fileId, assetType: 'face_drawing' });
    expect(a2.status).toBe(201);

    const assets = (await t.owner.get(`/v1/kartes/${k.id}`)).body.assets as { id: string; asset_type: string }[];
    expect(assets.map((a) => a.id)).toEqual([a2.body.id]);
    const old = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('files').select('status').where('id', '=', first.fileId).executeTakeFirstOrThrow());
    expect(old.status).toBe('deleted');
    // a photo upload cannot be passed off as the drawing
    const photo = await uploadTestFile(t.owner);
    expect((await t.owner.post(`/v1/kartes/${k.id}/assets`, { fileId: photo.fileId, assetType: 'face_drawing' })).status).toBe(400);
  });
});
