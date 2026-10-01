import { describe, expect, it } from 'vitest';
import { signCustomerToken } from '../../auth/jwt.js';
import {
  api,
  asSystem,
  createCustomer,
  createMenu,
  createStaffUser,
  createTenant,
  getApp,
  jst,
  nextWeekday,
  uploadTestFile,
  type Tenant,
} from '../../test/helpers.js';

async function templateByName(t: Tenant, name: string) {
  const res = await t.owner.get('/v1/karte-templates');
  const tpl = (res.body as { id: string; name: string; fields: { key: string }[] }[]).find((x) => x.name === name);
  if (!tpl) throw new Error(`template ${name} not found`);
  return tpl;
}

const colorFields = { color_type: 'リタッチ', patch_test: '実施済み(異常なし)', target_level: 9, formula: '8N:7A=1:1 OX6% 30分', result_color: 'アッシュブラウン' };

async function fetchBlobStatus(url: string) {
  const app = await getApp();
  const u = new URL(url);
  const res = await app.inject({ method: 'GET', url: u.pathname });
  return res.statusCode;
}

describe('karte templates', () => {
  it('seeds default karte and form templates for new organizations', async () => {
    const t = await createTenant();
    const kt = await t.owner.get('/v1/karte-templates');
    expect(kt.body.map((x: { name: string }) => x.name).sort()).toEqual(['カット', 'カラー', 'トリートメント', 'パーマ'].sort());
    expect(kt.body.find((x: { name: string }) => x.name === 'カット').is_default).toBe(true);
    const ft = await t.owner.get('/v1/form-templates');
    expect(ft.body.map((x: { name: string }) => x.name).sort()).toEqual(['カウンセリングシート', 'カラー施術同意書', '事前アンケート'].sort());
    expect(ft.body.find((x: { kind: string }) => x.kind === 'consent').requires_signature).toBe(true);
  });

  it('manages templates with form.manage and validates field definitions', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    const body = { name: 'ネイル', category: 'nail', fields: [{ key: 'design', label: 'デザイン', type: 'select', options: ['ワンカラー', 'グラデーション'], required: true }] };
    expect((await stylist.api.post('/v1/karte-templates', body)).status).toBe(403);
    const dup = await t.owner.post('/v1/karte-templates', { ...body, fields: [...body.fields, { key: 'design', label: '重複', type: 'text' }] });
    expect(dup.status).toBe(400);
    const noOptions = await t.owner.post('/v1/karte-templates', { ...body, fields: [{ key: 'x', label: 'x', type: 'select' }] });
    expect(noOptions.status).toBe(400);
    const created = await t.owner.post('/v1/karte-templates', body);
    expect(created.status).toBe(201);
    const upd = await t.owner.patch(`/v1/karte-templates/${created.body.id}`, { name: 'ネイル(ジェル)' });
    expect(upd.body.name).toBe('ネイル(ジェル)');
    expect((await t.owner.delete(`/v1/karte-templates/${created.body.id}`)).status).toBe(204);
    const list = await stylist.api.get('/v1/karte-templates');
    expect(list.body.map((x: { id: string }) => x.id)).not.toContain(created.body.id);
  });
});

describe('kartes', () => {
  it('creates kartes validated against the template, audits views, paginates and soft-deletes', async () => {
    const t = await createTenant();
    const customer = await createCustomer(t);
    const color = await templateByName(t, 'カラー');

    const missing = await t.owner.post('/v1/kartes', { customerId: customer.id, shopId: t.shopId, templateId: color.id, fields: { color_type: 'リタッチ' } });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details.issues.map((i: { path: string }) => i.path)).toEqual(['patch_test']);
    const badOption = await t.owner.post('/v1/kartes', { customerId: customer.id, shopId: t.shopId, templateId: color.id, fields: { ...colorFields, color_type: '謎' } });
    expect(badOption.status).toBe(400);
    const badNumber = await t.owner.post('/v1/kartes', { customerId: customer.id, shopId: t.shopId, templateId: color.id, fields: { ...colorFields, target_level: 99 } });
    expect(badNumber.status).toBe(400);
    const unknown = await t.owner.post('/v1/kartes', { customerId: customer.id, shopId: t.shopId, templateId: color.id, fields: { ...colorFields, secret: 'x' } });
    expect(unknown.status).toBe(400);

    const created = await t.owner.post('/v1/kartes', {
      customerId: customer.id,
      shopId: t.shopId,
      templateId: color.id,
      visitDate: '2026-09-01',
      fields: colorFields,
      chemicals: [{ name: 'イルミナカラー', brand: 'WELLA', ratio: '1:1', processingMin: 30 }],
      note: '根元の白髪多め',
      homecare: { advice: 'カラーシャンプーを週2回' },
    });
    expect(created.status).toBe(201);
    expect(created.body.staff_id).toBe(t.ownerStaffId);
    expect(created.body.version).toBe(1);
    expect(created.body.chemicals[0]).toMatchObject({ name: 'イルミナカラー', processing_min: 30 });
    expect(created.body.template.name).toBe('カラー');
    const id = created.body.id;

    const detail = await t.owner.get(`/v1/kartes/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.fields.formula).toBe('8N:7A=1:1 OX6% 30分');

    // template-less karte with free-form fields
    for (const d of ['2026-09-10', '2026-09-20']) {
      const r = await t.owner.post('/v1/kartes', { customerId: customer.id, shopId: t.shopId, visitDate: d, fields: { memo_key: 'x' } });
      expect(r.status).toBe(201);
    }
    const p1 = await t.owner.get('/v1/kartes', { customerId: customer.id, limit: 2 });
    expect(p1.body.items.map((k: { visit_date: string }) => k.visit_date)).toEqual(['2026-09-20', '2026-09-10']);
    const p2 = await t.owner.get('/v1/kartes', { customerId: customer.id, limit: 2, cursor: p1.body.nextCursor });
    expect(p2.body.items.map((k: { id: string }) => k.id)).toEqual([id]);
    expect(p2.body.nextCursor).toBeNull();

    const del = await t.owner.delete(`/v1/kartes/${id}`);
    expect(del.status).toBe(204);
    expect((await t.owner.get(`/v1/kartes/${id}`)).status).toBe(404);

    const logs = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('audit_logs').select('action').where('resource_id', '=', id).orderBy('id').execute());
    expect(logs.map((l) => l.action)).toEqual(['karte.create', 'karte.view', 'karte.delete']);
    const events = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('domain_events').select('event_type').where('aggregate_id', '=', id).execute());
    expect(events.map((e) => e.event_type)).toEqual(['karte.created']);
  });

  it('updates with optimistic locking and audits the diff', async () => {
    const t = await createTenant();
    const customer = await createCustomer(t);
    const k = (await t.owner.post('/v1/kartes', { customerId: customer.id, shopId: t.shopId, fields: {}, note: '初回' })).body;
    const upd = await t.owner.patch(`/v1/kartes/${k.id}`, { version: 1, note: '2回目のメモ' });
    expect(upd.status).toBe(200);
    expect(upd.body.version).toBe(2);
    const stale = await t.owner.patch(`/v1/kartes/${k.id}`, { version: 1, note: '古い画面から' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 2 } });
    const log = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('audit_logs').select(['before', 'after']).where('resource_id', '=', k.id).where('action', '=', 'karte.update').executeTakeFirstOrThrow(),
    );
    expect(log.before).toEqual({ note: '初回' });
    expect(log.after).toEqual({ note: '2回目のメモ' });

    // switching to a template re-validates fields
    const cut = await templateByName(t, 'カット');
    const bad = await t.owner.patch(`/v1/kartes/${k.id}`, { version: 2, templateId: cut.id, fields: { nope: 1 } });
    expect(bad.status).toBe(400);
    const ok = await t.owner.patch(`/v1/kartes/${k.id}`, { version: 2, templateId: cut.id, fields: { style_name: 'ショートボブ' } });
    expect(ok.status).toBe(200);
    expect(ok.body.template_id).toBe(cut.id);
  });

  it('validates that the appointment belongs to the customer and shop', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    const menu = await createMenu(t);
    const c1 = await createCustomer(t);
    const c2 = await createCustomer(t);
    const date = nextWeekday(3);
    const appt = await t.owner.post('/v1/appointments', { shopId: t.shopId, customerId: c1.id, staffId: stylist.staffId, startAt: jst(date, '12:00'), menuIds: [menu.id] });
    expect(appt.status).toBe(201);
    const mismatch = await t.owner.post('/v1/kartes', { customerId: c2.id, shopId: t.shopId, appointmentId: appt.body.id, fields: {} });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe('APPOINTMENT_MISMATCH');
    const ok = await stylist.api.post('/v1/kartes', { customerId: c1.id, shopId: t.shopId, appointmentId: appt.body.id, fields: {} });
    expect(ok.status).toBe(201);
    expect(ok.body.visit_date).toBe(date);
    expect(ok.body.staff_id).toBe(stylist.staffId);
    const byAppt = await t.owner.get('/v1/kartes', { appointmentId: appt.body.id });
    expect(byAppt.body.items).toHaveLength(1);
  });

  it('enforces shop and customer boundaries', async () => {
    const t = await createTenant();
    const shop2 = (await t.owner.post('/v1/shops', { name: '2号店', slug: `k2-${Date.now()}` })).body;
    const stylist = await createStaffUser(t, 'stylist'); // main shop only
    const reception = await createStaffUser(t, 'reception');
    // cross-shop reader: custom role granting customer.read_all_shops (not part of the default manager role)
    await t.owner.post('/v1/roles', {
      key: 'area_manager',
      name: 'エリアマネージャー',
      permissions: ['staff.read', 'customer.read', 'customer.read_all_shops', 'karte.read', 'karte.write'],
    });
    const manager = await createStaffUser(t, 'area_manager');
    const c2 = await createCustomer(t, { primaryShopId: shop2.id });
    const shared = await createCustomer(t); // main shop customer
    const k2 = (await t.owner.post('/v1/kartes', { customerId: c2.id, shopId: shop2.id, fields: {}, note: '2号店の記録' })).body;
    const kShared = (await t.owner.post('/v1/kartes', { customerId: shared.id, shopId: shop2.id, fields: {} })).body;

    expect((await stylist.api.get(`/v1/kartes/${k2.id}`)).status).toBe(404);
    // customer visible, but the karte belongs to another shop
    expect((await stylist.api.get(`/v1/kartes/${kShared.id}`)).status).toBe(404);
    const list = await stylist.api.get('/v1/kartes');
    expect(list.body.items.map((k: { id: string }) => k.id)).not.toContain(kShared.id);
    expect((await stylist.api.post('/v1/kartes', { customerId: shared.id, shopId: shop2.id, fields: {} })).status).toBe(403);
    expect((await stylist.api.patch(`/v1/kartes/${k2.id}`, { version: 1, note: 'x' })).status).toBe(404);
    expect((await reception.api.get('/v1/kartes')).status).toBe(403);
    expect((await reception.api.post('/v1/kartes', { customerId: shared.id, shopId: t.shopId, fields: {} })).status).toBe(403);

    // cross-shop reader may read but not write in a shop they are not assigned to
    expect((await manager.api.get(`/v1/kartes/${k2.id}`)).status).toBe(200);
    expect((await manager.api.patch(`/v1/kartes/${k2.id}`, { version: 1, note: 'x' })).status).toBe(403);
  });

  it('isolates tenants', async () => {
    const a = await createTenant('A');
    const b = await createTenant('B');
    const c = await createCustomer(a);
    const k = (await a.owner.post('/v1/kartes', { customerId: c.id, shopId: a.shopId, fields: {} })).body;
    expect((await b.owner.get(`/v1/kartes/${k.id}`)).status).toBe(404);
    expect((await b.owner.patch(`/v1/kartes/${k.id}`, { version: 1, note: 'x' })).status).toBe(404);
    expect((await b.owner.get('/v1/kartes')).body.items).toHaveLength(0);
    // cannot create a karte for another tenant's customer
    expect((await b.owner.post('/v1/kartes', { customerId: c.id, shopId: b.shopId, fields: {} })).status).toBe(404);
    // cannot attach another tenant's file
    const f = await uploadTestFile(a.owner);
    const kb = (await b.owner.post('/v1/kartes', { customerId: (await createCustomer(b)).id, shopId: b.shopId, fields: {} })).body;
    expect((await b.owner.post(`/v1/kartes/${kb.id}/assets`, { fileId: f.fileId, assetType: 'photo' })).status).toBe(404);
  });

  it('returns the latest karte and duplicates it for the next visit', async () => {
    const t = await createTenant();
    const c = await createCustomer(t);
    const color = await templateByName(t, 'カラー');
    expect((await t.owner.get(`/v1/customers/${c.id}/kartes/latest`)).body.karte).toBeNull();
    await t.owner.post('/v1/kartes', { customerId: c.id, shopId: t.shopId, visitDate: '2026-07-01', fields: {} });
    const prev = (
      await t.owner.post('/v1/kartes', {
        customerId: c.id,
        shopId: t.shopId,
        templateId: color.id,
        visitDate: '2026-08-01',
        fields: colorFields,
        chemicals: [{ name: 'アディクシー', ratio: '1:2' }],
        note: '内部メモ',
      })
    ).body;
    const latest = await t.owner.get(`/v1/customers/${c.id}/kartes/latest`);
    expect(latest.body.karte.id).toBe(prev.id);
    const dup = await t.owner.post(`/v1/kartes/${prev.id}/duplicate`, { visitDate: '2026-09-15' });
    expect(dup.status).toBe(201);
    expect(dup.body).toMatchObject({ duplicated_from: prev.id, visit_date: '2026-09-15', template_id: color.id, note: null });
    expect(dup.body.fields).toEqual(prev.fields);
    expect(dup.body.chemicals[0].name).toBe('アディクシー');
    expect(dup.body.id).not.toBe(prev.id);
  });
});

describe('karte assets & customer sharing', () => {
  async function setup() {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist', { displayName: '担当 花子' });
    const c = await createCustomer(t);
    const cut = await templateByName(t, 'カット');
    const k = (
      await stylist.api.post('/v1/kartes', {
        customerId: c.id,
        shopId: t.shopId,
        templateId: cut.id,
        fields: { style_name: 'ショートボブ', hair_texture: '細い', styling_advice: 'ドライ時は根元から', request: '社内向け要望メモ' },
        chemicals: [{ name: '秘密の薬剤', ratio: '1:1' }],
        note: '内部メモ: クレーム注意',
        homecare: { advice: '週1回のトリートメントがおすすめです' },
      })
    ).body;
    return { t, stylist, c, k };
  }

  it('attaches uploaded photos with signed URLs and manages them', async () => {
    const { t, stylist, k } = await setup();
    const before = await uploadTestFile(stylist.api);
    const after = await uploadTestFile(stylist.api);
    const a1 = await stylist.api.post(`/v1/kartes/${k.id}/assets`, { fileId: before.fileId, assetType: 'photo_before', caption: '施術前' });
    expect(a1.status).toBe(201);
    expect(a1.body.url).toContain('/v1/files/blob/');
    expect(a1.body.sort_order).toBe(0);
    const a2 = await stylist.api.post(`/v1/kartes/${k.id}/assets`, { fileId: after.fileId, assetType: 'photo_after', shareWithCustomer: true });
    expect(a2.body.sort_order).toBe(1);
    // same file twice
    expect((await stylist.api.post(`/v1/kartes/${k.id}/assets`, { fileId: after.fileId, assetType: 'photo' })).status).toBe(409);
    // wrong purpose (signature) / not uploaded
    const sig = await uploadTestFile(stylist.api, { purpose: 'signature' });
    expect((await stylist.api.post(`/v1/kartes/${k.id}/assets`, { fileId: sig.fileId, assetType: 'photo' })).status).toBe(400);
    const pending = await stylist.api.post('/v1/files/presign', { purpose: 'karte_photo', contentType: 'image/png', sizeBytes: 10 });
    expect((await stylist.api.post(`/v1/kartes/${k.id}/assets`, { fileId: pending.body.fileId, assetType: 'photo' })).status).toBe(422);

    const list = await t.owner.get(`/v1/kartes/${k.id}/assets`);
    expect(list.body.map((a: { caption: string | null }) => a.caption)).toEqual(['施術前', null]);
    expect(await fetchBlobStatus(list.body[0].url)).toBe(200);
    // once attached, other staff with karte access can download via /files/:id/url
    expect((await t.owner.get(`/v1/files/${before.fileId}/url`)).status).toBe(200);
    // an attached file cannot be deleted directly
    expect((await stylist.api.delete(`/v1/files/${before.fileId}`)).status).toBe(409);

    const upd = await stylist.api.patch(`/v1/kartes/${k.id}/assets/${a1.body.id}`, { caption: 'ビフォー', sortOrder: 5 });
    expect(upd.body).toMatchObject({ caption: 'ビフォー', sort_order: 5 });
    expect((await stylist.api.delete(`/v1/kartes/${k.id}/assets/${a1.body.id}`)).status).toBe(204);
    expect((await t.owner.get(`/v1/kartes/${k.id}`)).body.assets).toHaveLength(1);
    const f = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('files').select('status').where('id', '=', before.fileId).executeTakeFirstOrThrow());
    expect(f.status).toBe('deleted');
  });

  it('shares only customer-safe data and stops working after revoke / expiry', async () => {
    const { t, stylist, c, k } = await setup();
    const shown = await uploadTestFile(stylist.api);
    const hidden = await uploadTestFile(stylist.api);
    await stylist.api.post(`/v1/kartes/${k.id}/assets`, { fileId: shown.fileId, assetType: 'photo_after', shareWithCustomer: true, caption: '仕上がり' });
    await stylist.api.post(`/v1/kartes/${k.id}/assets`, { fileId: hidden.fileId, assetType: 'photo', shareWithCustomer: false, caption: '非公開写真' });

    const share = await stylist.api.post(`/v1/kartes/${k.id}/share`, { expiresInDays: 14, notify: true });
    expect(share.status).toBe(200);
    expect(share.body.url).toMatch(/\/k\/[\w-]+$/);
    expect(share.body.messageId).toBeTruthy();
    const msg = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('messages').select(['body', 'category', 'customer_id']).where('id', '=', share.body.messageId).executeTakeFirstOrThrow());
    expect(msg).toMatchObject({ category: 'transactional', customer_id: c.id });
    expect(msg.body).toContain(share.body.url);

    const token = share.body.url.split('/').pop();
    const view = await api().get(`/v1/public/karte-shares/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.staff.displayName).toBe('担当 花子');
    expect(view.body.homecare.advice).toBe('週1回のトリートメントがおすすめです');
    expect(view.body.fields.map((f: { key: string }) => f.key).sort()).toEqual(['style_name', 'styling_advice']);
    expect(view.body.assets).toHaveLength(1);
    expect(view.body.assets[0].caption).toBe('仕上がり');
    expect(await fetchBlobStatus(view.body.assets[0].url)).toBe(200);
    const raw = JSON.stringify(view.body);
    for (const secret of ['内部メモ', '秘密の薬剤', '社内向け要望メモ', '細い', '非公開写真', 'chemicals', 'note']) {
      expect(raw, secret).not.toContain(secret);
    }

    // authenticated customer sees shared kartes only
    const unshared = (await stylist.api.post('/v1/kartes', { customerId: c.id, shopId: t.shopId, fields: {} })).body;
    const customerToken = await signCustomerToken({ sub: c.id, org: t.organizationId, via: 'line' });
    const mine = await api(customerToken).get('/v1/public/me/kartes');
    expect(mine.status).toBe(200);
    expect(mine.body.map((x: { id: string }) => x.id)).toEqual([k.id]);
    expect(JSON.stringify(mine.body)).not.toContain('内部メモ');
    expect((await api(customerToken).get(`/v1/public/me/kartes/${unshared.id}`)).status).toBe(404);
    expect((await api(t.ownerToken).get('/v1/public/me/kartes')).status).toBe(403);

    // revoke
    expect((await stylist.api.delete(`/v1/kartes/${k.id}/share`)).status).toBe(204);
    const revoked = await api().get(`/v1/public/karte-shares/${token}`);
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.code).toBe('INVALID_LINK');
    expect((await api(customerToken).get('/v1/public/me/kartes')).body).toHaveLength(0);

    // re-share rotates the token; expiry stops it
    const again = await stylist.api.post(`/v1/kartes/${k.id}/share`, {});
    const token2 = again.body.url.split('/').pop();
    expect((await api().get(`/v1/public/karte-shares/${token2}`)).status).toBe(200);
    await asSystem(t.organizationId, (ctx) =>
      ctx.trx.updateTable('access_tokens').set({ expires_at: new Date(Date.now() - 1000) }).where('resource_id', '=', k.id).where('revoked_at', 'is', null).execute(),
    );
    expect((await api().get(`/v1/public/karte-shares/${token2}`)).status).toBe(401);
    // a random token
    expect((await api().get('/v1/public/karte-shares/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status).toBe(401);

    const events = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('domain_events').select('event_type').where('aggregate_id', '=', k.id).where('event_type', '=', 'karte.shared').execute(),
    );
    expect(events).toHaveLength(2);
  });

  it('stops the share link when the karte is deleted', async () => {
    const { stylist, k } = await setup();
    const share = await stylist.api.post(`/v1/kartes/${k.id}/share`, {});
    const token = share.body.url.split('/').pop();
    await stylist.api.delete(`/v1/kartes/${k.id}`);
    expect((await api().get(`/v1/public/karte-shares/${token}`)).status).toBe(401);
  });
});
