import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { storage } from '../../lib/storage.js';
import { api, asSystem, createCustomer, createMenu, createStaffUser, createTenant, jst, nextWeekday, TEST_PNG, uploadTestFile, type Tenant } from '../../test/helpers.js';

const SIGNATURE = `data:image/png;base64,${TEST_PNG.toString('base64')}`;

async function formByKind(t: Tenant, kind: string) {
  const res = await t.owner.get('/v1/form-templates', { kind });
  return res.body[0] as { id: string; name: string; version: number; lineage_id: string; fields: { key: string }[] };
}

const consentAnswers = { patch_test: '実施済み', past_reaction: 'いいえ', scalp_trouble: 'いいえ', pregnancy: 'いいえ', agree: true };

describe('form templates', () => {
  it('versions templates once they have responses and keeps old responses immutable', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    const c = await createCustomer(t);
    const created = await t.owner.post('/v1/form-templates', {
      kind: 'counseling',
      name: '初回カウンセリング',
      fields: [{ key: 'concern', label: 'お悩み', type: 'textarea', required: true }],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ version: 1, lineage_id: created.body.id, status: 'active' });
    expect((await stylist.api.post('/v1/form-templates', { kind: 'counseling', name: 'x', fields: [] })).status).toBe(403);

    // unused → edited in place
    const inPlace = await t.owner.patch(`/v1/form-templates/${created.body.id}`, { name: '初回カウンセリングシート' });
    expect(inPlace.body).toMatchObject({ id: created.body.id, version: 1, new_version: false });

    const resp = await stylist.api.post('/v1/form-responses', { templateId: created.body.id, customerId: c.id, answers: { concern: '広がり' } });
    expect(resp.status).toBe(201);

    // used → new version, old archived
    const v2 = await t.owner.patch(`/v1/form-templates/${created.body.id}`, {
      fields: [
        { key: 'concern', label: 'お悩み', type: 'textarea', required: true },
        { key: 'scalp', label: '頭皮の状態', type: 'select', options: ['良好', '乾燥'] },
      ],
    });
    expect(v2.status).toBe(200);
    expect(v2.body).toMatchObject({ version: 2, lineage_id: created.body.id, new_version: true, previous_version_id: created.body.id, status: 'active' });
    expect(v2.body.id).not.toBe(created.body.id);
    const old = await t.owner.get(`/v1/form-templates/${created.body.id}`);
    expect(old.body.status).toBe('archived');
    expect(old.body.fields).toHaveLength(1);
    const versions = await t.owner.get(`/v1/form-templates/${v2.body.id}/versions`);
    expect(versions.body.map((v: { version: number }) => v.version)).toEqual([2, 1]);

    // editing the superseded version is refused; old versions cannot be answered
    const stale = await t.owner.patch(`/v1/form-templates/${created.body.id}`, { name: 'x' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('TEMPLATE_SUPERSEDED');
    const oldAnswer = await stylist.api.post('/v1/form-responses', { templateId: created.body.id, customerId: c.id, answers: { concern: 'x' } });
    expect(oldAnswer.status).toBe(422);
    expect(oldAnswer.body.error.code).toBe('TEMPLATE_INACTIVE');

    // the old response still carries its own snapshot of v1
    const detail = await stylist.api.get(`/v1/form-responses/${resp.body.id}`);
    expect(detail.body.template_version).toBe(1);
    expect(detail.body.template_snapshot.fields).toHaveLength(1);
    expect(detail.body.template_snapshot.name).toBe('初回カウンセリングシート');

    // status-only change on the latest version is in place
    const archived = await t.owner.patch(`/v1/form-templates/${v2.body.id}`, { status: 'archived' });
    expect(archived.body).toMatchObject({ version: 2, status: 'archived', new_version: false });
    const list = await t.owner.get('/v1/form-templates', { kind: 'counseling' });
    expect(list.body.map((x: { id: string }) => x.id)).not.toContain(v2.body.id);
  });
});

describe('form responses (staff)', () => {
  it('stores signature, hashes the document, verifies integrity and is immutable', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    const c = await createCustomer(t, { lastName: '署名', firstName: '花子' });
    const consent = await formByKind(t, 'consent');

    const noSig = await stylist.api.post('/v1/form-responses', { templateId: consent.id, customerId: c.id, answers: consentAnswers });
    expect(noSig.status).toBe(422);
    expect(noSig.body.error.code).toBe('SIGNATURE_REQUIRED');
    const notAgreed = await stylist.api.post('/v1/form-responses', {
      templateId: consent.id,
      customerId: c.id,
      answers: { ...consentAnswers, agree: false },
      signature: { dataUrl: SIGNATURE, signerName: '署名 花子' },
    });
    expect(notAgreed.status).toBe(400);
    const notPng = await stylist.api.post('/v1/form-responses', {
      templateId: consent.id,
      customerId: c.id,
      answers: consentAnswers,
      signature: { dataUrl: `data:image/png;base64,${Buffer.from('GIF89a-not-png').toString('base64')}`, signerName: '署名 花子' },
    });
    expect(notPng.status).toBe(415);

    const res = await stylist.api.post('/v1/form-responses', {
      templateId: consent.id,
      customerId: c.id,
      answers: consentAnswers,
      signature: { dataUrl: SIGNATURE, signerName: '署名 花子' },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'submitted', submitted_via: 'staff', signer_name: '署名 花子', template_version: consent.version });
    expect(res.body.document_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.signed_at).toBeTruthy();
    const id = res.body.id;

    const file = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('files').selectAll().where('id', '=', res.body.signature_file_id).executeTakeFirstOrThrow());
    expect(file).toMatchObject({ purpose: 'signature', status: 'uploaded', content_type: 'image/png', size_bytes: TEST_PNG.length });
    expect(file.object_key).toContain(`org/${t.organizationId}/signature/`);

    const detail = await t.owner.get(`/v1/form-responses/${id}`);
    expect(detail.body.signature.url).toContain('/v1/files/blob/');
    expect((await t.owner.get(`/v1/files/${file.id}/url`)).status).toBe(200);
    expect((await t.owner.delete(`/v1/files/${file.id}`)).status).toBe(409);

    const verify = await t.owner.get(`/v1/form-responses/${id}/verify`);
    expect(verify.body).toMatchObject({ valid: true, hashMatches: true, signature: { present: true, intact: true } });
    expect(verify.body.recomputedHash).toBe(res.body.document_hash);

    // immutability: API and database
    const patch = await t.owner.patch(`/v1/form-responses/${id}`, { answers: { agree: false } });
    expect(patch.status).toBe(409);
    expect(patch.body.error.code).toBe('FORM_RESPONSE_IMMUTABLE');
    await expect(
      asSystem(t.organizationId, (ctx) => ctx.trx.updateTable('form_responses').set({ answers: JSON.stringify({ agree: false }) }).where('id', '=', id).execute()),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(asSystem(t.organizationId, (ctx) => ctx.trx.deleteFrom('form_responses').where('id', '=', id).execute())).rejects.toBeTruthy();

    // printable document escapes content
    const html = await t.owner.get(`/v1/form-responses/${id}/html`);
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(String(html.body)).toContain('カラー施術に関する同意書');
    expect(String(html.body)).toContain('署名者: 署名 花子');
    expect(String(html.body)).toContain(res.body.document_hash);

    // tampering with the signature bytes in storage is detected
    await storage.put(file.object_key, Buffer.concat([TEST_PNG, Buffer.from('x')]), 'image/png');
    const tampered = await t.owner.get(`/v1/form-responses/${id}/verify`);
    expect(tampered.body).toMatchObject({ valid: false, hashMatches: true, signature: { intact: false } });
    await storage.put(file.object_key, TEST_PNG, 'image/png');

    // tampering with stored answers (bypassing the trigger) is detected
    await asSystem(t.organizationId, async (ctx) => {
      await sql`ALTER TABLE form_responses DISABLE TRIGGER form_responses_immutable`.execute(ctx.trx);
      await ctx.trx.updateTable('form_responses').set({ answers: JSON.stringify({ ...consentAnswers, past_reaction: 'はい' }) }).where('id', '=', id).execute();
      await sql`ALTER TABLE form_responses ENABLE TRIGGER form_responses_immutable`.execute(ctx.trx);
    });
    const forged = await t.owner.get(`/v1/form-responses/${id}/verify`);
    expect(forged.body).toMatchObject({ valid: false, hashMatches: false });

    // void (form.manage) with reason
    expect((await stylist.api.post(`/v1/form-responses/${id}/void`, { reason: '誤記入' })).status).toBe(403);
    const voided = await t.owner.post(`/v1/form-responses/${id}/void`, { reason: '誤記入のため再取得' });
    expect(voided.body).toMatchObject({ status: 'voided', void_reason: '誤記入のため再取得' });
    expect((await t.owner.post(`/v1/form-responses/${id}/void`, { reason: 'again' })).status).toBe(409);
    const voidHtml = await t.owner.get(`/v1/form-responses/${id}/html`);
    expect(String(voidHtml.body)).toContain('無効化されています');
    const actions = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('audit_logs').select('action').where('resource_id', '=', id).orderBy('id').execute());
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(['form.submit', 'form_response.view', 'form_response.verify', 'form_response.print', 'form_response.void']));
    const events = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('domain_events').select('event_type').where('aggregate_id', '=', id).execute());
    expect(events.map((e) => e.event_type)).toEqual(['form.submitted']);

    const list = await t.owner.get('/v1/form-responses', { customerId: c.id });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ kind: 'consent', status: 'voided' });
  });

  it('accepts a pre-uploaded signature file once and validates links to appointment/karte', async () => {
    const t = await createTenant();
    const c = await createCustomer(t);
    const other = await createCustomer(t);
    const consent = await formByKind(t, 'consent');
    const sig = await uploadTestFile(t.owner, { purpose: 'signature' });
    const k = (await t.owner.post('/v1/kartes', { customerId: c.id, shopId: t.shopId, fields: {} })).body;
    const mismatch = await t.owner.post('/v1/form-responses', { templateId: consent.id, customerId: other.id, karteId: k.id, answers: consentAnswers, signature: { fileId: sig.fileId, signerName: 'A' } });
    expect(mismatch.status).toBe(422);
    const ok = await t.owner.post('/v1/form-responses', { templateId: consent.id, customerId: c.id, karteId: k.id, answers: consentAnswers, signature: { fileId: sig.fileId, signerName: 'A' } });
    expect(ok.status).toBe(201);
    expect(ok.body.signature_file_id).toBe(sig.fileId);
    expect(ok.body.karte_id).toBe(k.id);
    expect((await t.owner.get(`/v1/form-responses/${ok.body.id}/verify`)).body.valid).toBe(true);
    const reuse = await t.owner.post('/v1/form-responses', { templateId: consent.id, customerId: c.id, answers: consentAnswers, signature: { fileId: sig.fileId, signerName: 'A' } });
    expect(reuse.status).toBe(409);
  });

  it('enforces permissions, customer visibility and tenant isolation', async () => {
    const t = await createTenant();
    const shop2 = (await t.owner.post('/v1/shops', { name: '2号店', slug: `f2-${Date.now()}` })).body;
    const stylist = await createStaffUser(t, 'stylist');
    const reception = await createStaffUser(t, 'reception');
    const c2 = await createCustomer(t, { primaryShopId: shop2.id });
    const counseling = await formByKind(t, 'counseling');
    const r = (await t.owner.post('/v1/form-responses', { templateId: counseling.id, customerId: c2.id, answers: { menus: ['カット'] } })).body;
    expect((await stylist.api.get(`/v1/form-responses/${r.id}`)).status).toBe(404);
    expect((await stylist.api.get('/v1/form-responses', { customerId: c2.id })).status).toBe(404);
    expect((await stylist.api.post('/v1/form-responses', { templateId: counseling.id, customerId: c2.id, answers: { menus: ['カット'] } })).status).toBe(404);
    expect((await reception.api.post('/v1/form-responses', { templateId: counseling.id, customerId: c2.id, answers: { menus: ['カット'] } })).status).toBe(403);

    const b = await createTenant('B');
    expect((await b.owner.get(`/v1/form-responses/${r.id}`)).status).toBe(404);
    expect((await b.owner.get(`/v1/form-responses/${r.id}/verify`)).status).toBe(404);
    expect((await b.owner.get(`/v1/form-templates/${counseling.id}`)).status).toBe(404);
    expect((await b.owner.post('/v1/form-responses', { templateId: counseling.id, customerId: c2.id, answers: {} })).status).toBe(404);
  });
});

describe('customer form links (事前入力)', () => {
  it('issues a single-use link for an appointment, maps answers into the customer profile', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    const reception = await createStaffUser(t, 'reception');
    const menu = await createMenu(t);
    const c = await createCustomer(t, { lastName: '事前', firstName: '入力' });
    const date = nextWeekday(3);
    const appt = (await t.owner.post('/v1/appointments', { shopId: t.shopId, customerId: c.id, staffId: stylist.staffId, startAt: jst(date, '14:00'), menuIds: [menu.id] })).body;
    const preVisit = await formByKind(t, 'pre_visit');

    // reception (appointment.write) can send pre-visit forms
    const link = await reception.api.post(`/v1/appointments/${appt.id}/pre-visit-form`, { templateId: preVisit.id, notify: true });
    expect(link.status).toBe(201);
    expect(link.body.url).toMatch(/\/f\/[\w-]+$/);
    expect(new Date(link.body.expiresAt).getTime()).toBeGreaterThan(new Date(appt.start_at).getTime());
    const msg = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('messages').select(['body', 'appointment_id']).where('id', '=', link.body.messageId).executeTakeFirstOrThrow());
    expect(msg.body).toContain(link.body.url);
    expect(msg.appointment_id).toBe(appt.id);
    const token = link.body.url.split('/').pop();

    const view = await api().get(`/v1/public/forms/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.form.name).toBe('事前アンケート');
    expect(view.body.customer).toMatchObject({ lastName: '事前', firstName: '入力' });
    expect(view.body.appointment.startAt).toBe(appt.start_at);
    expect(JSON.stringify(view.body)).not.toContain('phone');

    // invalid answers do not consume the link
    const bad = await api().post(`/v1/public/forms/${token}`, { answers: { conversation: '歌いたい' } });
    expect(bad.status).toBe(400);
    const submit = await api().post(`/v1/public/forms/${token}`, {
      answers: { allergies: 'ジアミン', hair_concerns: ['広がり', 'ダメージ'], conversation: '静かに過ごしたい' },
    });
    expect(submit.status).toBe(201);
    expect(submit.body.documentHash).toMatch(/^[0-9a-f]{64}$/);

    // single use
    expect((await api().post(`/v1/public/forms/${token}`, { answers: {} })).status).toBe(401);
    expect((await api().get(`/v1/public/forms/${token}`)).status).toBe(401);

    const resp = await t.owner.get(`/v1/form-responses/${submit.body.responseId}`);
    expect(resp.body).toMatchObject({ status: 'submitted', submitted_via: 'customer_link', appointment_id: appt.id, shop_id: t.shopId });
    expect(resp.body.ip).toBeTruthy();
    const customer = await t.owner.get(`/v1/customers/${c.id}`);
    expect(customer.body.attributes).toMatchObject({ allergies: 'ジアミン', hair_concerns: ['広がり', 'ダメージ'] });
    const events = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('domain_events').select(['event_type', 'payload']).where('aggregate_id', '=', submit.body.responseId).execute());
    expect(events[0]).toMatchObject({ event_type: 'form.submitted', payload: { via: 'customer_link', kind: 'pre_visit', appointmentId: appt.id } });

    // next link prefills mapped answers from the profile
    const link2 = await t.owner.post(`/v1/customers/${c.id}/form-links`, { templateId: preVisit.id });
    const view2 = await api().get(`/v1/public/forms/${link2.body.url.split('/').pop()}`);
    expect(view2.body.prefill).toMatchObject({ allergies: 'ジアミン', hair_concerns: ['広がり', 'ダメージ'] });
  });

  it('collects a remote consent signature via link and rejects expired / voided links', async () => {
    const t = await createTenant();
    const c = await createCustomer(t);
    const consent = await formByKind(t, 'consent');
    const link = await t.owner.post(`/v1/customers/${c.id}/form-links`, { templateId: consent.id, expiresInDays: 3 });
    expect(link.status).toBe(201);
    const token = link.body.url.split('/').pop();
    const noSig = await api().post(`/v1/public/forms/${token}`, { answers: consentAnswers });
    expect(noSig.status).toBe(422);
    const ok = await api().post(`/v1/public/forms/${token}`, { answers: consentAnswers, signature: { dataUrl: SIGNATURE, signerName: '遠隔 署名' } });
    expect(ok.status).toBe(201);
    const verify = await t.owner.get(`/v1/form-responses/${ok.body.responseId}/verify`);
    expect(verify.body).toMatchObject({ valid: true, signature: { present: true, intact: true } });

    // expired link
    const link2 = await t.owner.post(`/v1/customers/${c.id}/form-links`, { templateId: consent.id });
    await asSystem(t.organizationId, (ctx) =>
      ctx.trx.updateTable('access_tokens').set({ expires_at: new Date(Date.now() - 1000) }).where('resource_id', '=', link2.body.responseId).execute(),
    );
    expect((await api().get(`/v1/public/forms/${link2.body.url.split('/').pop()}`)).status).toBe(401);

    // voided pending link
    const link3 = await t.owner.post(`/v1/customers/${c.id}/form-links`, { templateId: consent.id });
    expect((await t.owner.post(`/v1/form-responses/${link3.body.responseId}/void`, { reason: '送信先誤り' })).status).toBe(200);
    expect((await api().get(`/v1/public/forms/${link3.body.url.split('/').pop()}`)).status).toBe(401);

    // pending responses cannot be verified
    const link4 = await t.owner.post(`/v1/customers/${c.id}/form-links`, { templateId: consent.id });
    expect((await t.owner.get(`/v1/form-responses/${link4.body.responseId}/verify`)).status).toBe(422);
    // permissions: stylist of another shop cannot issue links for invisible customers
    const shop2 = (await t.owner.post('/v1/shops', { name: '2号店', slug: `fl-${Date.now()}` })).body;
    const c2 = await createCustomer(t, { primaryShopId: shop2.id });
    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.post(`/v1/customers/${c2.id}/form-links`, { templateId: consent.id })).status).toBe(404);
  });
});
