import { beforeEach, describe, expect, it } from 'vitest';
import { api, asSystem, createCustomer, createStaffUser, createTenant, shopSlug, TEST_PNG, type Tenant } from '../../test/helpers.js';

const SIGNATURE = `data:image/png;base64,${TEST_PNG.toString('base64')}`;
/** Anonymous client with its own client IP per call site (public routes are rate limited per IP) */
let ipSeq = 0;
function visitor() {
  ipSeq++;
  const headers = { 'x-forwarded-for': `10.77.${(ipSeq >> 8) & 255}.${ipSeq & 255}` };
  const client = api();
  return {
    get: (url: string, query?: Record<string, unknown>) => client.get(url, query, headers),
    post: (url: string, body?: unknown) => client.post(url, body, headers),
  };
}
let anon = visitor();
beforeEach(() => {
  anon = visitor();
});

const person = (over: Record<string, unknown> = {}) => ({
  lastName: '来店',
  firstName: '花子',
  lastNameKana: 'ライテン',
  firstNameKana: 'ハナコ',
  birthday: '1990-04-12',
  phone: '090-1111-2222',
  occupation: '会社員',
  visitReason: 'Instagram',
  ...over,
});

/** A shop consent without questions or signature (the seeded カラー施術同意書 has both) */
async function simpleConsent(t: Tenant, name = '施術同意書') {
  const res = await t.owner.post('/v1/form-templates', {
    kind: 'consent',
    name,
    shopId: t.shopId,
    fields: [],
    bodyMarkdown: '## 個人情報について\n- 施術以外の目的で利用しません\n\n## その他\n体調がすぐれない場合はお申し出ください。',
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; lineage_id: string; version: number };
}

async function counselingForm(t: Tenant, name = '目') {
  const res = await t.owner.post('/v1/form-templates', {
    kind: 'counseling',
    name,
    fields: [
      { key: 'allergies', label: 'アレルギーについて', type: 'multiselect', options: ['花粉', 'ゴム', '金属'], mapsTo: 'allergies' },
      { key: 'contact_lens', label: 'コンタクトレンズは装着されていますか？', type: 'select', options: ['していない', 'ソフト', 'ハード'], required: true },
    ],
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; lineage_id: string };
}

async function submit(slug: string, templateId: string, over: Record<string, unknown> = {}) {
  const res = await anon.post(`/v1/public/walkin/${slug}`, { templateId, customer: person(), agreed: true, ...over });
  if (res.status !== 201) throw new Error(`walk-in submit failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { intakeId: string; token: string; submittedAt: string };
}

const pending = async (t: Tenant, q?: string) => (await t.owner.get('/v1/walkin-intakes', { shopId: t.shopId, q })).body.items as { id: string; customer_name: string }[];

describe('walk-in reception page (public)', () => {
  it('shows the shop consent and the staff of the QR', async () => {
    const t = await createTenant('受付サロン');
    const slug = await shopSlug(t);
    const stylist = await createStaffUser(t, 'stylist', { displayName: '受付 担当' });
    const consent = await simpleConsent(t);

    const view = await anon.get(`/v1/public/walkin/${slug}`, { staff: stylist.staffId });
    expect(view.status).toBe(200);
    expect(view.body.shop).toEqual({ name: (await t.owner.get(`/v1/shops/${t.shopId}`)).body.name });
    expect(view.body.staff).toEqual({ id: stylist.staffId, name: '受付 担当' });
    // the shop's own consent wins over the organization-wide (seeded) one
    expect(view.body.consent).toMatchObject({ templateId: consent.id, lineageId: consent.lineage_id, name: '施術同意書', requiresSignature: false, fields: [] });
    expect(view.body.consent.bodyMarkdown).toContain('個人情報について');

    // another consent can be chosen with ?form=<lineage>; unknown staff / unknown shop
    const seeded = (await t.owner.get('/v1/form-templates', { kind: 'consent' })).body.find((x: { id: string }) => x.id !== consent.id);
    expect((await anon.get(`/v1/public/walkin/${slug}`, { form: seeded.lineage_id })).body.consent).toMatchObject({ templateId: seeded.id, requiresSignature: true });
    expect((await anon.get(`/v1/public/walkin/${slug}`, { staff: '00000000-0000-4000-8000-000000000000' })).body.staff).toBeNull();
    expect((await anon.get('/v1/public/walkin/no-such-shop')).status).toBe(404);

    // reception does not depend on online booking, but a closed shop has none
    await t.owner.patch(`/v1/shops/${t.shopId}`, { publicBookingEnabled: false });
    expect((await anon.get(`/v1/public/walkin/${slug}`)).status).toBe(200);
  });

  it('validates the details, the agreement and the consent questions', async () => {
    const t = await createTenant();
    const slug = await shopSlug(t);
    const consent = await simpleConsent(t);
    const post = (body: Record<string, unknown>) => anon.post(`/v1/public/walkin/${slug}`, { templateId: consent.id, customer: person(), agreed: true, ...body });

    expect((await post({ agreed: false })).status).toBe(400);
    expect((await post({ customer: person({ lastNameKana: '' }) })).status).toBe(400);
    expect((await post({ customer: person({ phone: '123' }) })).status).toBe(400);
    expect((await post({ customer: person({ birthday: '2999-01-01' }) })).status).toBe(400);
    expect((await post({ answers: { unknown_key: 'x' } })).status).toBe(400);
    expect((await post({ templateId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    // a counselling form is not a consent
    const eye = await counselingForm(t);
    expect((await post({ templateId: eye.id })).status).toBe(404);
    expect(await pending(t)).toHaveLength(0);

    // the seeded consent has required questions and a signature
    const seeded = (await t.owner.get('/v1/form-templates', { kind: 'consent' })).body.find((x: { id: string }) => x.id !== consent.id);
    const answers = { patch_test: '実施済み', past_reaction: 'いいえ', scalp_trouble: 'いいえ', agree: true };
    expect((await post({ templateId: seeded.id })).status).toBe(400);
    const unsigned = await post({ templateId: seeded.id, answers });
    expect(unsigned.status).toBe(422);
    expect(unsigned.body.error.code).toBe('SIGNATURE_REQUIRED');
    const signed = await post({ templateId: seeded.id, answers, signature: { dataUrl: SIGNATURE, signerName: '来店 花子' } });
    expect(signed.status).toBe(201);
    expect(await pending(t)).toHaveLength(1);

    // an edited consent (new version) must be re-read before agreeing
    const v2 = await t.owner.patch(`/v1/form-templates/${seeded.id}`, { bodyMarkdown: '改訂版' });
    expect(v2.body.new_version).toBe(true);
    const stale = await post({ templateId: seeded.id, answers, signature: { dataUrl: SIGNATURE, signerName: '来店 花子' } });
    expect(stale.status).toBe(422);
    expect(stale.body.error.code).toBe('TEMPLATE_INACTIVE');
  });
});

describe('walk-in intakes (staff)', () => {
  it('lists pending intakes with search, shows the detail and registers a new customer', async () => {
    const t = await createTenant();
    const slug = await shopSlug(t);
    const stylist = await createStaffUser(t, 'stylist', { displayName: '担当 太郎' });
    const consent = await simpleConsent(t);

    const first = await submit(slug, consent.id, { staffId: stylist.staffId });
    await submit(slug, consent.id, { customer: person({ lastName: '別', firstName: '次郎', lastNameKana: 'ベツ', firstNameKana: 'ジロウ', phone: '080-3333-4444' }) });

    const list = await t.owner.get('/v1/walkin-intakes', { shopId: t.shopId });
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    const row = list.body.items.find((i: { id: string }) => i.id === first.intakeId);
    expect(row).toMatchObject({
      status: 'pending',
      customer_id: null,
      customer_name: '来店 花子',
      customer_name_kana: 'ライテン ハナコ',
      customer_phone: '090-1111-2222',
      customer_birthday: '1990-04-12',
      staff_id: stylist.staffId,
      staff_name: '担当 太郎',
      has_counseling: false,
    });
    // newest first, cursor pagination
    const page1 = await t.owner.get('/v1/walkin-intakes', { shopId: t.shopId, limit: 1 });
    expect(page1.body.items.map((i: { customer_name: string }) => i.customer_name)).toEqual(['別 次郎']);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    const page2 = await t.owner.get('/v1/walkin-intakes', { shopId: t.shopId, limit: 1, cursor: page1.body.nextCursor });
    expect(page2.body.items.map((i: { id: string }) => i.id)).toEqual([first.intakeId]);
    expect(page2.body.nextCursor).toBeNull();
    // search: name, kana (hiragana input), phone digits
    expect((await pending(t, '来店')).map((i) => i.id)).toEqual([first.intakeId]);
    expect((await pending(t, 'らいてん')).map((i) => i.id)).toEqual([first.intakeId]);
    expect((await pending(t, '1111')).map((i) => i.id)).toEqual([first.intakeId]);
    expect((await pending(t, 'ジロウ')).map((i) => i.customer_name)).toEqual(['別 次郎']);
    expect(await pending(t, '該当なし')).toHaveLength(0);

    // counselling sheet after the consent: a category sent again replaces what was sent, others are kept
    const counseling = (data: unknown, token = first.token) => anon.post(`/v1/public/walkin-intakes/${token}/counseling`, { data });
    expect((await counseling({})).status).toBe(400);
    expect((await counseling({ eye_counseling: { allergies: [], questions: '  ' } })).status).toBe(400);
    expect((await counseling({ eye_counseling: { allergies: 5 } })).status).toBe(400);
    expect((await counseling({ eye_counseling: { allergies: ['花粉'], contact_lens: 'ソフト' }, hair: { hair_volume: '75' } })).status).toBe(201);
    const again = await counseling({ eye_counseling: { allergies: ['金属'], contact_lens: 'ハード', questions: '' } });
    expect(again.status).toBe(201);
    expect(again.body.categories.sort()).toEqual(['eye_counseling', 'hair']);
    expect((await counseling({ nail: { nail_experience: 'はい' } }, 'not-a-real-token-000000')).status).toBe(401);
    expect((await pending(t)).find((i) => i.id === first.intakeId)).toMatchObject({ has_counseling: true });

    const detail = await t.owner.get(`/v1/walkin-intakes/${first.intakeId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.intake).toMatchObject({
      customer_name: '来店 花子',
      customer_occupation: '会社員',
      customer_visit_reason: 'Instagram',
      staff_name: '担当 太郎',
      has_counseling: true,
    });
    expect(detail.body.intake.consent_snapshot).toMatchObject({ title: '施術同意書', fields: [], signature: null });
    expect(detail.body.intake.consent_snapshot.body_markdown).toContain('## 個人情報について');
    expect(detail.body.intake.consent_snapshot.agreed_at).toBe(detail.body.intake.consent_submitted_at);
    expect(detail.body.intake.counseling_data).toEqual({ eye_counseling: { allergies: ['金属'], contact_lens: 'ハード' }, hair: { hair_volume: '75' } });
    expect(detail.body.intake.counseling_submitted_at).toEqual(expect.any(String));

    // 新規顧客として登録
    const created = await t.owner.post(`/v1/walkin-intakes/${first.intakeId}/create`);
    expect(created.status).toBe(201);
    const customerId = created.body.customerId as string;
    expect(created.body.counselingCategories.sort()).toEqual(['eye_counseling', 'hair']);
    const customer = (await t.owner.get(`/v1/customers/${customerId}`)).body;
    expect(customer).toMatchObject({
      last_name: '来店',
      first_name: '花子',
      last_name_kana: 'ライテン',
      first_name_kana: 'ハナコ',
      birthday: '1990-04-12',
      phone: '090-1111-2222',
      occupation: '会社員',
      acquisition_source: 'Instagram',
      primary_shop_id: t.shopId,
      primary_staff_id: stylist.staffId,
    });
    // the counselling answers are on the customer's counselling sheet
    const sheet = (await t.owner.get(`/v1/customers/${customerId}/counseling-sheet`)).body.counseling_sheet;
    expect(sheet).toMatchObject({ customer_id: customerId, shop_id: t.shopId, data: { eye_counseling: { allergies: ['金属'], contact_lens: 'ハード' }, hair: { hair_volume: '75' } } });

    // the consent is now an ordinary, verifiable form response of the customer
    const responses = (await t.owner.get('/v1/form-responses', { customerId })).body.items as { id: string; kind: string; status: string; submitted_via: string; submitted_at: string }[];
    expect(responses.map((r) => r.kind)).toEqual(['consent']);
    expect(responses.every((r) => r.status === 'submitted' && r.submitted_via === 'customer_link')).toBe(true);
    const consentResponse = responses.find((r) => r.kind === 'consent')!;
    expect(consentResponse.id).toBe(created.body.consentResponseId);
    expect(new Date(consentResponse.submitted_at).toISOString()).toBe(new Date(first.submittedAt).toISOString());
    const full = (await t.owner.get(`/v1/form-responses/${consentResponse.id}`)).body;
    expect(full.answers).toMatchObject({ walkin_name: '来店 花子', walkin_name_kana: 'ライテン ハナコ', walkin_birthday: '1990-04-12', walkin_phone: '090-1111-2222', walkin_agreed: true });
    for (const r of responses) {
      expect((await t.owner.get(`/v1/form-responses/${r.id}/verify`)).body).toMatchObject({ valid: true, hashMatches: true });
    }

    // it left the pending list and cannot be processed twice
    expect((await pending(t)).map((i) => i.customer_name)).toEqual(['別 次郎']);
    expect((await t.owner.get('/v1/walkin-intakes', { shopId: t.shopId, status: 'created' })).body.items).toHaveLength(1);
    for (const action of ['create', 'discard']) {
      const again = await t.owner.post(`/v1/walkin-intakes/${first.intakeId}/${action}`);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('WALKIN_ALREADY_RESOLVED');
    }

    // a category filled after registration goes straight onto the customer's sheet
    expect((await counseling({ nail: { nail_experience: 'はい' } })).status).toBe(201);
    const after = (await t.owner.get(`/v1/customers/${customerId}/counseling-sheet`)).body.counseling_sheet;
    expect(Object.keys(after.data).sort()).toEqual(['eye_counseling', 'hair', 'nail']);
    expect(after.data.nail).toEqual({ nail_experience: 'はい' });
  });

  it('links an intake to an existing customer, filling only blank profile fields', async () => {
    const t = await createTenant();
    const slug = await shopSlug(t);
    const consent = (await t.owner.get('/v1/form-templates', { kind: 'consent' })).body[0];
    const answers = { patch_test: '実施済み', past_reaction: 'いいえ', scalp_trouble: 'いいえ', pregnancy: 'いいえ', agree: true };
    const intake = await submit(slug, consent.id, { answers, signature: { dataUrl: SIGNATURE, signerName: '来店 花子' } });
    const existing = await createCustomer(t, { lastName: '既存', firstName: '花子', phone: '03-0000-0000' });
    // the customer already has a counselling sheet; the walk-in customer fills 目 again and 眉 for the first time
    expect((await t.owner.put(`/v1/customers/${existing.id}/counseling-sheet`, { data: { hair: { hair_curl: 'あり' }, eye_counseling: { contact_lens: 'ソフト', questions: '以前の質問' } } })).status).toBe(200);
    expect((await anon.post(`/v1/public/walkin-intakes/${intake.token}/counseling`, { data: { eye_counseling: { contact_lens: 'ハード' }, eyebrow: { patch_test: '希望' } } })).status).toBe(201);

    const detail = (await t.owner.get(`/v1/walkin-intakes/${intake.intakeId}`)).body.intake;
    expect(detail.consent_snapshot.signature.url).toEqual(expect.any(String));
    expect(detail.consent_snapshot.signer_name).toBe('来店 花子');
    expect(detail.consent_snapshot.fields.map((f: { key: string }) => f.key)).toEqual(['patch_test', 'past_reaction', 'scalp_trouble', 'pregnancy', 'agree']);
    expect(detail.consent_snapshot.answers).toMatchObject(answers);

    const linked = await t.owner.post(`/v1/walkin-intakes/${intake.intakeId}/link`, { customerId: existing.id });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ customerId: existing.id });
    expect(linked.body.counselingCategories.sort()).toEqual(['eye_counseling', 'eyebrow']);
    // categories the walk-in customer filled replace the same categories; the others stay
    expect((await t.owner.get(`/v1/customers/${existing.id}/counseling-sheet`)).body.counseling_sheet.data).toEqual({
      hair: { hair_curl: 'あり' },
      eye_counseling: { contact_lens: 'ハード' },
      eyebrow: { patch_test: '希望' },
    });
    expect(linked.body.filled.sort()).toEqual(['acquisitionSource', 'birthday', 'firstNameKana', 'lastNameKana', 'occupation']);
    const customer = (await t.owner.get(`/v1/customers/${existing.id}`)).body;
    // name and phone were already there → untouched
    expect(customer).toMatchObject({ last_name: '既存', first_name: '花子', phone: '03-0000-0000', last_name_kana: 'ライテン', first_name_kana: 'ハナコ', birthday: '1990-04-12', occupation: '会社員', acquisition_source: 'Instagram' });
    expect(customer.attributes.pregnancy).toBe('いいえ');

    const verify = await t.owner.get(`/v1/form-responses/${linked.body.consentResponseId}/verify`);
    expect(verify.body).toMatchObject({ valid: true, hashMatches: true, signature: { present: true, intact: true } });
    expect(await pending(t)).toHaveLength(0);
    expect((await t.owner.post(`/v1/walkin-intakes/${intake.intakeId}/link`, { customerId: existing.id })).status).toBe(409);
  });

  it('discards an intake and closes its counselling link', async () => {
    const t = await createTenant();
    const slug = await shopSlug(t);
    const consent = await simpleConsent(t);
    const intake = await submit(slug, consent.id);
    const discarded = await t.owner.post(`/v1/walkin-intakes/${intake.intakeId}/discard`);
    expect(discarded.status).toBe(200);
    expect(await pending(t)).toHaveLength(0);
    expect((await t.owner.get('/v1/walkin-intakes', { shopId: t.shopId, status: 'discarded' })).body.items).toHaveLength(1);
    expect((await anon.post(`/v1/public/walkin-intakes/${intake.token}/counseling`, { data: { eye_counseling: { contact_lens: 'ソフト' } } })).status).toBe(401);
    // no customer and no form response were created
    const counts = await asSystem(t.organizationId, async (ctx) => ({
      responses: await ctx.trx.selectFrom('form_responses').select('id').execute(),
      customers: await ctx.trx.selectFrom('customers').select('id').execute(),
    }));
    expect(counts).toEqual({ responses: [], customers: [] });
  });

  it('enforces permissions, shop access and tenant isolation', async () => {
    const t = await createTenant();
    const other = await createTenant();
    const slug = await shopSlug(t);
    const consent = await simpleConsent(t);
    const intake = await submit(slug, consent.id);
    const existing = await createCustomer(t);

    // 受付 (no karte.read) cannot see the list; アシスタント (karte.write, no customer.write) can link but not create
    const reception = await createStaffUser(t, 'reception');
    expect((await reception.api.get('/v1/walkin-intakes', { shopId: t.shopId })).status).toBe(403);
    expect((await reception.api.get(`/v1/walkin-intakes/${intake.intakeId}`)).status).toBe(403);
    expect((await reception.api.post(`/v1/walkin-intakes/${intake.intakeId}/discard`)).status).toBe(403);
    const assistant = await createStaffUser(t, 'assistant');
    expect((await assistant.api.get('/v1/walkin-intakes', { shopId: t.shopId })).status).toBe(200);
    expect((await assistant.api.post(`/v1/walkin-intakes/${intake.intakeId}/create`)).status).toBe(403);

    // staff of another shop
    const shop2 = await t.owner.post('/v1/shops', { name: '2号店', slug: `w2-${Date.now()}` });
    const stylist2 = await createStaffUser(t, 'stylist', { shopIds: [shop2.body.id] });
    expect((await stylist2.api.get('/v1/walkin-intakes', { shopId: t.shopId })).status).toBe(403);
    expect((await stylist2.api.get(`/v1/walkin-intakes/${intake.intakeId}`)).status).toBe(404);
    expect((await stylist2.api.post(`/v1/walkin-intakes/${intake.intakeId}/discard`)).status).toBe(404);
    expect((await stylist2.api.get('/v1/walkin-intakes', { shopId: shop2.body.id })).body.items).toHaveLength(0);

    // another tenant
    expect((await other.owner.get(`/v1/walkin-intakes/${intake.intakeId}`)).status).toBe(404);
    expect((await other.owner.post(`/v1/walkin-intakes/${intake.intakeId}/discard`)).status).toBe(404);
    // an owner may name any shop id; row level security keeps the other tenant's rows out
    expect((await other.owner.get('/v1/walkin-intakes', { shopId: t.shopId })).body.items).toEqual([]);
    const foreign = await createCustomer(other);
    expect((await t.owner.post(`/v1/walkin-intakes/${intake.intakeId}/link`, { customerId: foreign.id })).status).toBe(404);
    expect(await pending(t)).toHaveLength(1);

    // the assistant links without touching the customer profile
    const linked = await assistant.api.post(`/v1/walkin-intakes/${intake.intakeId}/link`, { customerId: existing.id });
    expect(linked.status).toBe(200);
    expect(linked.body.filled).toEqual([]);
    expect((await t.owner.get(`/v1/customers/${existing.id}`)).body.birthday).toBeNull();
  });

  it('gives the reception QR link of the shop and of one staff member', async () => {
    const t = await createTenant();
    const slug = await shopSlug(t);
    const consent = await simpleConsent(t);
    const stylist = await createStaffUser(t, 'stylist', { displayName: 'QR 担当' });

    const shopLink = await t.owner.get('/v1/walkin-intakes/reception-link', { shopId: t.shopId });
    expect(shopLink.status).toBe(200);
    expect(shopLink.body.url).toMatch(new RegExp(`/consent/${slug}$`));
    expect(shopLink.body.staff).toBeNull();
    expect(shopLink.body.consentForms[0]).toMatchObject({ lineageId: consent.lineage_id, name: '施術同意書' });
    expect(shopLink.body.consentForms).toHaveLength(2);
    expect(shopLink.body.consentForms[1].url).toContain(`form=${shopLink.body.consentForms[1].lineageId}`);

    const staffLink = await t.owner.get('/v1/walkin-intakes/reception-link', { shopId: t.shopId, staffId: stylist.staffId });
    expect(staffLink.body.url).toMatch(new RegExp(`/consent/${slug}\\?staff=${stylist.staffId}$`));
    expect(staffLink.body.staff).toEqual({ id: stylist.staffId, name: 'QR 担当' });
    expect((await t.owner.get('/v1/walkin-intakes/reception-link', { shopId: t.shopId, staffId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);

    // the page the QR opens records that staff member on the intake
    const view = await anon.get(`/v1/public/walkin/${slug}`, { staff: stylist.staffId });
    const intake = await submit(slug, view.body.consent.templateId, { staffId: view.body.staff.id });
    expect((await t.owner.get(`/v1/walkin-intakes/${intake.intakeId}`)).body.intake.staff_name).toBe('QR 担当');
  });
});
