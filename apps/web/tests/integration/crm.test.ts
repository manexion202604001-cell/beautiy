import { describe, expect, it } from 'vitest';
import { prisma } from '@salonos/db';
import { piiColumns, decryptField } from '@/lib/server/pii';
import {
  adjustPoints, addTag, createCustomer, customerDetailStats, customerTimeline, duplicateCandidates, importCustomers,
  normalizeBirthday, searchCustomers, softDeleteCustomer, updateCustomer, type CustomerInput,
} from '@/lib/server/crm';
import {
  copyFromPrevious, createKarte, getCounselingByToken, getSharedKarte, issueCounselingLink, parseSketch, previousKarte,
  saveCounselingForm, setKarteShare, submitCounseling, updateKarte, validateAnswers, CounselingValidationError,
  deleteKartePhoto, sendKarteShare, updateKartePhoto,
} from '@/lib/server/karte';
import { makeOrg } from './helpers';

const base: CustomerInput = { lastName: '', firstName: '', lineOptIn: true, emailOptIn: true, favorite: false };

async function appt(orgId: string, shopId: string, customerId: string | null, daysAgo: number) {
  const startAt = new Date(Date.now() - daysAgo * 86400000);
  return prisma.appointment.create({ data: { organizationId: orgId, shopId, customerId, startAt, endAt: new Date(startAt.getTime() + 3600000), status: 'COMPLETED' } });
}

describe('CRM search', () => {
  it('finds customers by exact phone/email blind index and by normalized kana/name', async () => {
    const { org, staff } = await makeOrg();
    const actor = { orgId: org.id, userId: staff[0].userId };
    const a = await createCustomer(actor, { ...base, lastName: '山田', firstName: '花子', lastNameKana: 'やまだ', firstNameKana: 'はなこ', phone: '090-1234-5678', email: 'Hanako@Example.com' });
    await createCustomer(actor, { ...base, lastName: '佐藤', firstName: '太郎', lastNameKana: 'サトウ', firstNameKana: 'タロウ', phone: '09099998888' });
    // kana stored normalized to katakana
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: a.id } })).lastNameKana).toBe('ヤマダ');

    const byPhone = await searchCustomers(org.id, { q: '+81 90 1234 5678' });
    expect(byPhone.mode).toBe('phone');
    expect(byPhone.items.map((i) => i.id)).toEqual([a.id]);
    expect(byPhone.items[0].phone).toBe('*******5678');
    expect((await searchCustomers(org.id, { q: '0901234' })).items).toHaveLength(0); // partial phone never matches
    expect((await searchCustomers(org.id, { q: 'hanako@example.com' })).items.map((i) => i.id)).toEqual([a.id]);
    expect((await searchCustomers(org.id, { q: 'ヤマダ' })).items.map((i) => i.id)).toEqual([a.id]);
    expect((await searchCustomers(org.id, { q: 'やまだ はな' })).items.map((i) => i.id)).toEqual([a.id]);
    expect((await searchCustomers(org.id, { q: '山田花子' })).items.map((i) => i.id)).toEqual([a.id]);
    // tenant isolation
    const other = await makeOrg();
    expect((await searchCustomers(other.org.id, { q: '09012345678' })).items).toHaveLength(0);
  });

  it('filters by tag / favorite / lifecycle and excludes merged or deleted customers', async () => {
    const { org, shop, staff } = await makeOrg();
    const actor = { orgId: org.id, userId: staff[0].userId };
    const d = (n: number) => new Date(Date.now() - n * 86400000);
    const active = await prisma.customer.create({ data: { organizationId: org.id, lastName: 'A', firstName: '1', visitCount: 3, firstVisitAt: d(80), lastVisitAt: d(10), favorite: true } });
    const dormant = await prisma.customer.create({ data: { organizationId: org.id, lastName: 'B', firstName: '2', visitCount: 2, firstVisitAt: d(400), lastVisitAt: d(200) } });
    const prospect = await prisma.customer.create({ data: { organizationId: org.id, lastName: 'C', firstName: '3' } });
    const gone = await prisma.customer.create({ data: { organizationId: org.id, lastName: 'D', firstName: '4' } });
    await softDeleteCustomer(actor, gone.id, 'test');
    await addTag(actor, dormant.id, { name: 'VIP' });
    const all = await searchCustomers(org.id, {});
    expect(all.total).toBe(3);
    expect(all.items[0].id).toBe(active.id); // last visit desc
    expect((await searchCustomers(org.id, { lifecycle: 'DORMANT' })).items.map((i) => i.id)).toEqual([dormant.id]);
    expect((await searchCustomers(org.id, { lifecycle: 'PROSPECT' })).items.map((i) => i.id)).toEqual([prospect.id]);
    expect((await searchCustomers(org.id, { lifecycle: 'ACTIVE' })).items.map((i) => i.id)).toEqual([active.id]);
    expect((await searchCustomers(org.id, { favorite: true })).items.map((i) => i.id)).toEqual([active.id]);
    const tag = await prisma.tag.findFirstOrThrow({ where: { organizationId: org.id, name: 'VIP' } });
    expect((await searchCustomers(org.id, { tagId: tag.id })).items.map((i) => i.id)).toEqual([dormant.id]);
    const audits = await prisma.auditLog.count({ where: { organizationId: org.id, action: 'customer.delete', resourceId: gone.id } });
    expect(audits).toBe(1);
    void shop;
  });

  it('rejects duplicate contact on create unless allowed; masked editors cannot clear contact', async () => {
    const { org, staff } = await makeOrg();
    const actor = { orgId: org.id, userId: staff[0].userId };
    const c = await createCustomer(actor, { ...base, lastName: '田中', firstName: '一', phone: '08011112222' });
    await expect(createCustomer(actor, { ...base, lastName: '田中', firstName: '二', phone: '080-1111-2222' })).rejects.toThrow(/登録済み/);
    await expect(createCustomer(actor, { ...base, lastName: '田中', firstName: '二', phone: '080-1111-2222' }, { allowDuplicate: true })).resolves.toBeTruthy();
    await updateCustomer(actor, c.id, { ...base, lastName: '田中', firstName: '一', phone: '' }, { contactEditable: false });
    expect(decryptField((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).phoneEnc)).toBe('08011112222');
    await updateCustomer(actor, c.id, { ...base, lastName: '田中', firstName: '一', phone: '' }, { contactEditable: true });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).phoneHash).toBeNull();
  });

  it('adjusts points with audit and never below zero; detail stats and timeline', async () => {
    const { org, shop, staff } = await makeOrg();
    const actor = { orgId: org.id, userId: staff[0].userId };
    const c = await prisma.customer.create({ data: { organizationId: org.id, lastName: 'P', firstName: 'Q' } });
    await adjustPoints(actor, c.id, 300, '誕生日');
    await expect(adjustPoints(actor, c.id, -500, '誤り')).rejects.toThrow(/残高/);
    const r = await adjustPoints(actor, c.id, -100, '修正');
    expect(r.balance).toBe(200);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: 'customer.points.adjust' } })).toBe(2);
    const a = await appt(org.id, shop.id, c.id, 10);
    await prisma.appointment.create({ data: { organizationId: org.id, shopId: shop.id, customerId: c.id, startAt: new Date(), endAt: new Date(Date.now() + 3600000), status: 'NO_SHOW' } });
    await prisma.transaction.create({ data: { organizationId: org.id, shopId: shop.id, customerId: c.id, appointmentId: a.id, status: 'PAID', total: 9000, subtotal: 9000, paidAt: a.startAt } });
    const s = await customerDetailStats(org.id, c.id);
    expect(s).toMatchObject({ visitCount: 1, ltv: 9000, avgSpend: 9000, noShowCount: 1, points: 200, lifecycle: 'NEW' });
    const tl = await customerTimeline(org.id, c.id);
    expect(tl.map((t) => t.kind).sort()).toEqual(['appointment', 'appointment', 'transaction']);
  });

  it('lists duplicate candidates by blind index + normalized kana', async () => {
    const { org } = await makeOrg();
    const a = await prisma.customer.create({ data: { organizationId: org.id, lastName: '山田', firstName: '花子', lastNameKana: 'ヤマダ', firstNameKana: 'ハナコ', ...piiColumns({ phone: '080-5555-0101' }) } });
    const b = await prisma.customer.create({ data: { organizationId: org.id, lastName: '山田', firstName: '花子', lastNameKana: 'やまだ', firstNameKana: 'はなこ', ...piiColumns({ phone: '08055550101' }) } });
    await prisma.customer.create({ data: { organizationId: org.id, lastName: '別', firstName: '人' } });
    const pairs = await duplicateCandidates(org.id);
    expect(pairs).toHaveLength(1);
    expect([pairs[0].a, pairs[0].b].sort()).toEqual([a.id, b.id].sort());
    expect(pairs[0].reasons).toContain('電話番号一致');
  });
});

describe('CRM CSV import', () => {
  it('dedupes by phone/email hash against DB and within the file (skip vs update, dry run)', async () => {
    const { org, staff } = await makeOrg();
    const actor = { orgId: org.id, userId: staff[0].userId };
    const existing = await prisma.customer.create({ data: { organizationId: org.id, lastName: '既存', firstName: '顧客', ...piiColumns({ phone: '09011110000', email: 'old@example.com' }) } });
    const rows = [
      { lastName: '新規', firstName: '一郎', phone: '090-2222-0000', tags: 'VIP;紹介' },
      { lastName: '既存', firstName: '更新', phone: '09011110000', birthday: '1990/4/1', tags: 'VIP' },
      { lastName: '同一', firstName: 'ファイル', email: 'NEW@example.com' },
      { fullName: '同一 重複', email: 'new@example.com' },
      { lastName: '', firstName: '名無し' },
      { lastName: '不正', firstName: '電話', phone: '123' },
      { lastName: 'メール', firstName: '一致', email: 'old@example.com' },
    ];
    const dry = await importCustomers(actor, rows, { mode: 'skip', dryRun: true });
    expect(dry).toMatchObject({ created: 2, skipped: 3, errors: 2, updated: 0 });
    expect(await prisma.customer.count({ where: { organizationId: org.id } })).toBe(1);

    const skip = await importCustomers(actor, rows, { mode: 'skip', dryRun: false });
    expect(skip).toMatchObject({ created: 2, skipped: 3, errors: 2 });
    expect(skip.rows.find((r) => r.row === 3)).toMatchObject({ action: 'skip', matchedBy: 'phone', customerId: existing.id });
    expect(await prisma.customer.count({ where: { organizationId: org.id } })).toBe(3);
    const vip = await prisma.tag.findFirstOrThrow({ where: { organizationId: org.id, name: 'VIP' }, include: { _count: { select: { customers: true } } } });
    expect(vip._count.customers).toBe(1);

    // re-import in update mode: nothing new is created, matches get updated
    const upd = await importCustomers(actor, rows, { mode: 'update', dryRun: false });
    expect(upd).toMatchObject({ created: 0, updated: 5, errors: 2 });
    const ex = await prisma.customer.findUniqueOrThrow({ where: { id: existing.id }, include: { tags: true } });
    expect(ex.birthday).toBe('1990-04-01');
    expect(ex.firstName).toBe('一致'); // last matching row (email) wins in update mode
    expect(ex.tags).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: 'customer.import' } })).toBe(2);
  });

  it('normalizes birthdays', () => {
    expect(normalizeBirthday('1990/4/1')).toBe('1990-04-01');
    expect(normalizeBirthday('19900401')).toBe('1990-04-01');
    expect(normalizeBirthday('1990年4月1日')).toBe('1990-04-01');
    expect(normalizeBirthday('1990-02-30')).toBeNull();
    expect(normalizeBirthday('abc')).toBeNull();
  });
});

describe('Karte', () => {
  it('enforces one karte per appointment (including concurrent creates)', async () => {
    const { org, shop, staff } = await makeOrg();
    const actor = { orgId: org.id, userId: staff[1].userId, shopIds: [shop.id] };
    const c = await prisma.customer.create({ data: { organizationId: org.id, lastName: 'K', firstName: 'A' } });
    const a = await appt(org.id, shop.id, c.id, 1);
    const results = await Promise.all([1, 2, 3].map(() => createKarte(actor, { appointmentId: a.id, shopId: shop.id, treatmentNote: 'x' })));
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.existing)).toHaveLength(1);
    expect(await prisma.karte.count({ where: { appointmentId: a.id } })).toBe(1);
    const k = await prisma.karte.findUniqueOrThrow({ where: { id: [...ids][0] } });
    expect(k.customerId).toBe(c.id);
    expect(k.visitDate.getTime()).toBe(a.startAt.getTime());
    // cross-tenant appointment is rejected
    const other = await makeOrg();
    await expect(createKarte({ orgId: other.org.id, userId: other.staff[0].userId, shopIds: [other.shop.id] }, { appointmentId: a.id, shopId: other.shop.id })).rejects.toThrow();
    // appointment without customer is rejected
    const guest = await appt(org.id, shop.id, null, 1);
    await expect(createKarte(actor, { appointmentId: guest.id, shopId: shop.id })).rejects.toThrow(/顧客/);
  });

  it('copies from the previous karte of the same customer', async () => {
    const { org, shop, staff } = await makeOrg();
    const actor = { orgId: org.id, userId: staff[0].userId, shopIds: [shop.id] };
    const c = await prisma.customer.create({ data: { organizationId: org.id, lastName: 'K', firstName: 'B' } });
    const other = await prisma.customer.create({ data: { organizationId: org.id, lastName: 'K', firstName: 'C' } });
    const a1 = await appt(org.id, shop.id, c.id, 60), a2 = await appt(org.id, shop.id, c.id, 30), a3 = await appt(org.id, shop.id, c.id, 0);
    await createKarte(actor, { appointmentId: a1.id, shopId: shop.id, treatmentNote: 'old', formulaNote: '6N' });
    await createKarte(actor, { appointmentId: a2.id, shopId: shop.id, treatmentNote: 'prev', formulaNote: '7N 40g', careMemo: 'care' });
    const oa = await appt(org.id, shop.id, other.id, 5);
    await createKarte(actor, { appointmentId: oa.id, shopId: shop.id, treatmentNote: 'other customer' });
    const cur = await createKarte(actor, { appointmentId: a3.id, shopId: shop.id });
    const prev = await previousKarte(org.id, c.id, { before: a3.startAt, excludeId: cur.id });
    expect(prev?.treatmentNote).toBe('prev');
    await copyFromPrevious(actor, cur.id);
    const k = await prisma.karte.findUniqueOrThrow({ where: { id: cur.id } });
    expect(k).toMatchObject({ treatmentNote: 'prev', formulaNote: '7N 40g', careMemo: 'care' });
    // first karte has nothing to copy from
    const first = await prisma.karte.findUniqueOrThrow({ where: { appointmentId: a1.id } });
    await expect(copyFromPrevious(actor, first.id)).rejects.toThrow(/前回/);
  });

  it('validates sketch JSON and stores it', async () => {
    const { org, shop, staff } = await makeOrg();
    const actor = { orgId: org.id, userId: staff[0].userId, shopIds: [shop.id] };
    const c = await prisma.customer.create({ data: { organizationId: org.id, lastName: 'S', firstName: 'K' } });
    const { id } = await createKarte(actor, { customerId: c.id, shopId: shop.id, visitDate: '2026-01-15' });
    const sketch = JSON.stringify({ v: 1, bg: 'head', strokes: [{ c: '#d6334a', w: 3, p: [[0.1, 0.2], [0.3, 0.4]] }] });
    await updateKarte(actor, id, { treatmentNote: 'n', sketchJson: sketch });
    const k = await prisma.karte.findUniqueOrThrow({ where: { id } });
    expect((k.sketchJson as any).strokes[0].p[1]).toEqual([0.3, 0.4]);
    expect(k.visitDate.toISOString().slice(0, 10)).toBe('2026-01-15');
    expect(() => parseSketch('{"v":1,"strokes":[{"c":"red","w":3,"p":[[0,0]]}]}')).toThrow();
    expect(() => parseSketch('not json')).toThrow();
  });

  it('share token: only enabled links resolve and only customer-facing data is exposed', async () => {
    const { org, shop, staff } = await makeOrg();
    const actor = { orgId: org.id, userId: staff[0].userId, shopIds: [shop.id] };
    const c = await prisma.customer.create({ data: { organizationId: org.id, lastName: '共有', firstName: '太郎', ...piiColumns({ phone: '09000001111' }) } });
    const { id } = await createKarte(actor, { customerId: c.id, shopId: shop.id, treatmentNote: 'INTERNAL', formulaNote: 'SECRET', assistantNote: 'ASSIST', careMemo: 'ケアメモ' });
    await prisma.kartePhoto.createMany({ data: [
      { karteId: id, kind: 'AFTER', storageKey: `org/${org.id}/karte/a.jpg`, contentType: 'image/jpeg', size: 1, shareable: true },
      { karteId: id, kind: 'BEFORE', storageKey: `org/${org.id}/karte/b.jpg`, contentType: 'image/jpeg', size: 1, shareable: false },
    ] });
    const on = await setKarteShare(actor, id, true);
    expect(on.shareToken!.length).toBeGreaterThanOrEqual(20);
    const shared = await getSharedKarte(on.shareToken!);
    expect(shared).not.toBeNull();
    expect(shared!.careMemo).toBe('ケアメモ');
    expect(shared!.photos).toHaveLength(1);
    expect(shared!.stylist?.name).toBe('Staff 0');
    const json = JSON.stringify(shared);
    for (const secret of ['INTERNAL', 'SECRET', 'ASSIST', '共有', '09000001111']) expect(json).not.toContain(secret);
    expect(await getSharedKarte('x'.repeat(24))).toBeNull();
    // disable → link stops working; re-enable keeps token unless regenerated
    await setKarteShare(actor, id, false);
    expect(await getSharedKarte(on.shareToken!)).toBeNull();
    const again = await setKarteShare(actor, id, true);
    expect(again.shareToken).toBe(on.shareToken);
    const regen = await setKarteShare(actor, id, true, { regenerate: true });
    expect(regen.shareToken).not.toBe(on.shareToken);
    expect(await getSharedKarte(on.shareToken!)).toBeNull();
    // deleted customer → link dead
    await prisma.customer.update({ where: { id: c.id }, data: { deletedAt: new Date() } });
    expect(await getSharedKarte(regen.shareToken!)).toBeNull();
    // other tenant cannot toggle
    const other = await makeOrg();
    await expect(setKarteShare({ orgId: other.org.id, userId: other.staff[0].userId, shopIds: [other.shop.id] }, id, true)).rejects.toThrow();
  });

  it('M3: karte photo/share/send and appointment-based create are limited to the caller\'s shops', async () => {
    const { org, shop, staff } = await makeOrg();
    const shopB = await prisma.shop.create({ data: { organizationId: org.id, name: 'B店', slug: `b-${Date.now().toString(36)}` } });
    const inA = { orgId: org.id, userId: staff[1].userId, shopIds: [shop.id] };
    const inB = { orgId: org.id, userId: staff[0].userId, shopIds: [shopB.id] };
    const c = await prisma.customer.create({ data: { organizationId: org.id, lastName: '他店', firstName: '客', ...piiColumns({ email: 'k@example.com' }) } });
    const { id } = await createKarte(inB, { customerId: c.id, shopId: shopB.id, careMemo: 'memo' });
    const photo = await prisma.kartePhoto.create({ data: { karteId: id, kind: 'AFTER', storageKey: `org/${org.id}/karte/x.jpg`, contentType: 'image/jpeg', size: 1, shareable: false } });

    await expect(updateKartePhoto(inA, photo.id, { shareable: true, caption: 'hacked' })).rejects.toThrow(/アクセス権/);
    await expect(deleteKartePhoto(inA, photo.id)).rejects.toThrow(/アクセス権/);
    await expect(setKarteShare(inA, id, true)).rejects.toThrow(/アクセス権/);
    const p0 = await prisma.kartePhoto.findUniqueOrThrow({ where: { id: photo.id } });
    expect(p0).toMatchObject({ shareable: false, caption: null });
    expect((await prisma.karte.findUniqueOrThrow({ where: { id } })).shareEnabled).toBe(false);

    // the owning shop can
    await updateKartePhoto(inB, photo.id, { shareable: true });
    await setKarteShare(inB, id, true);
    await expect(sendKarteShare(inA, id, 'EMAIL')).rejects.toThrow(/アクセス権/);
    const msg = await sendKarteShare(inB, id, 'EMAIL');
    expect(msg.status).toBe('SENT');
    expect(await prisma.message.count({ where: { customerId: c.id } })).toBe(1);

    // an appointment of shop B can't be used to create a karte from shop A
    const apptB = await appt(org.id, shopB.id, c.id, 1);
    await expect(createKarte(inA, { appointmentId: apptB.id, shopId: shop.id })).rejects.toThrow(/アクセス権/);
    await expect(createKarte(inA, { customerId: c.id, shopId: shopB.id })).rejects.toThrow(/アクセス権/);
    expect(await prisma.karte.count({ where: { appointmentId: apptB.id } })).toBe(0);
    await deleteKartePhoto(inB, photo.id);
    expect(await prisma.kartePhoto.count({ where: { id: photo.id } })).toBe(0);
  });
});

describe('Counseling', () => {
  const fields = [
    { id: 'concern', label: 'お悩み', type: 'multiselect' as const, options: ['パサつき', 'うねり'], required: true },
    { id: 'allergy', label: 'アレルギー', type: 'select' as const, options: ['なし', 'あり'], required: true },
    { id: 'memo', label: 'メモ', type: 'textarea' as const },
    { id: 'agree', label: '撮影OK', type: 'checkbox' as const },
    { id: 'last', label: '前回カラー', type: 'date' as const },
  ];

  it('validates form definitions', async () => {
    const { org, staff } = await makeOrg();
    const actor = { orgId: org.id, userId: staff[0].userId };
    await expect(saveCounselingForm(actor, null, { name: 'x', fields: [{ id: 'a', label: 'A', type: 'select' }], requireConsent: false, active: true })).rejects.toThrow();
    await expect(saveCounselingForm(actor, null, { name: 'x', fields: [{ id: 'a', label: 'A', type: 'text' }, { id: 'a', label: 'B', type: 'text' }], requireConsent: false, active: true })).rejects.toThrow();
    await expect(saveCounselingForm(actor, null, { name: 'x', fields: [{ id: 'a', label: 'A', type: 'text' }], requireConsent: true, consentText: '', active: true })).rejects.toThrow();
  });

  it('issues a self-entry link and accepts exactly one valid submission with e-signature', async () => {
    const { org, shop, staff } = await makeOrg();
    const actor = { orgId: org.id, userId: staff[0].userId };
    const c = await prisma.customer.create({ data: { organizationId: org.id, lastName: '署名', firstName: '花' } });
    const form = await saveCounselingForm(actor, null, { name: '初回', fields, requireConsent: true, consentText: '同意します', active: true });
    const a = await appt(org.id, shop.id, c.id, -1);
    const link = await issueCounselingLink(actor, { formId: form.id, appointmentId: a.id });
    expect(link.customerId).toBe(c.id);
    expect(link.status).toBe('PENDING');
    const view = await getCounselingByToken(link.token);
    expect(view?.form.fields).toHaveLength(5);
    expect(view?.shopName).toBe(shop.name);

    const sig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    // missing required + consent
    try {
      await submitCounseling(link.token, { answers: { concern: [], allergy: 'たぶん' } });
      throw new Error('should fail');
    } catch (e) {
      expect(e).toBeInstanceOf(CounselingValidationError);
      const fe = (e as CounselingValidationError).fieldErrors;
      expect(Object.keys(fe).sort()).toEqual(['_consent', '_signature', '_signedName', 'allergy', 'concern'].sort());
    }
    await expect(submitCounseling(link.token, { answers: { concern: ['パサつき'], allergy: 'なし' }, consent: true, signedName: '署名 花', signatureData: 'javascript:alert(1)' })).rejects.toThrow();

    await submitCounseling(link.token, { answers: { concern: ['パサつき', 'うねり'], allergy: 'なし', memo: ' 明るめ ', agree: 'on', last: '2026-08-01' }, consent: true, signedName: '署名 花', signatureData: sig });
    const r = await prisma.counselingResponse.findUniqueOrThrow({ where: { id: link.id } });
    expect(r.status).toBe('SUBMITTED');
    expect(r.answers).toEqual({ concern: ['パサつき', 'うねり'], allergy: 'なし', memo: '明るめ', agree: true, last: '2026-08-01' });
    expect(r.signedName).toBe('署名 花');
    expect(r.signatureData).toBe(sig);
    expect(r.signedAt).toBeTruthy();
    await expect(submitCounseling(link.token, { answers: { concern: ['うねり'], allergy: 'あり' }, consent: true, signedName: 'x', signatureData: sig })).rejects.toThrow(/送信済み/);
    expect((await getCounselingByToken(link.token))?.status).toBe('SUBMITTED');
    expect(await getCounselingByToken('nope-nope-nope-nope')).toBeNull();
  });

  it('validateAnswers ignores unknown keys and coerces checkbox', () => {
    const { answers, errors } = validateAnswers(fields, { concern: 'うねり', allergy: 'あり', extra: 'x', agree: 'false' });
    expect(errors).toEqual({});
    expect(answers).toEqual({ concern: ['うねり'], allergy: 'あり', memo: null, agree: false, last: null });
  });
});
