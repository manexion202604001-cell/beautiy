import { sql, type Selectable } from 'kysely';
import { DateTime } from 'luxon';
import { assertShopAccess, auditUserId, can, requirePermission, systemActor, type Ctx, type RequestMeta } from '../../auth/actor.js';
import { config } from '../../config.js';
import type { WalkinIntakes } from '../../db/types.js';
import { withSystem, withTenant } from '../../db/tenant.js';
import { assertTokenResource, issueAccessToken, resolveAccessToken } from '../../lib/access-tokens.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { normalizeKana, normalizePhone } from '../../lib/normalize.js';
import { assertCustomerAccess } from '../customers/access.js';
import { createCustomer, updateCustomer } from '../customers/service.js';
import { signedUrlFor } from '../files/api.js';
import { mergeIntoCounselingSheet } from './counseling.js';
import type { FieldValues } from './fields.js';
import { afterSubmit, prepareSubmission, snapshotOf, type FormTemplateRow, type TemplateSnapshot } from './forms.js';
import type { CounselingSheetData, FormField, ListWalkinIntakesInput, PublicWalkinCounselingInput, PublicWalkinSubmitInput } from './schemas.js';

/**
 * Walk-in intakes (同意書一覧・受付保留).
 *
 * A customer without a reservation scans the reception QR (/consent/:shopSlug[?staff=…]),
 * enters their details, agrees to the shop's consent form and may fill the counselling sheet
 * (髪 / 目 / エクステ / 眉 / ネイル / 顔 / 体 — the same sheet staff keep for a customer).
 * The submission waits as a `pending` intake until staff link it to an existing customer,
 * register a new customer from it, or discard it. Linking turns the consent into an ordinary
 * (immutable, hash-verified) form response of that customer and writes the counselling answers
 * onto the customer's counselling sheet, category by category.
 */
export type WalkinIntakeRow = Selectable<WalkinIntakes>;

/** A signed sheet as it is copied into form_responses */
interface SignedDocument {
  templateId: string;
  version: number;
  snapshot: TemplateSnapshot;
  answers: FieldValues;
  signatureFileId: string | null;
  signerName: string | null;
  signedAt: Date | null;
  submittedAt: Date;
  documentHash: string;
  ip: string | null;
  userAgent: string | null;
}

const INVALID_LINK = () => Errors.unauthenticated('リンクが無効か有効期限が切れています', 'INVALID_LINK');
const COUNSELING_TOKEN_TTL_SEC = 24 * 3600;

/** Details the customer types in; stored as answers of the signed consent so the document is self-contained */
const APPLICANT_FIELDS: FormField[] = [
  { key: 'walkin_name', label: 'お名前', type: 'text', required: true, maxLength: 120 },
  { key: 'walkin_name_kana', label: 'フリガナ', type: 'text', required: true, maxLength: 120 },
  { key: 'walkin_birthday', label: '生年月日', type: 'date', required: true },
  { key: 'walkin_phone', label: '電話番号', type: 'text', required: true, maxLength: 30 },
  { key: 'walkin_occupation', label: 'ご職業', type: 'text', maxLength: 100 },
  { key: 'walkin_visit_reason', label: 'ご来店のきっかけ', type: 'text', maxLength: 100 },
];
const AGREE_FIELD: FormField = { key: 'walkin_agreed', label: '上記の内容に同意します', type: 'checkbox', required: true };
const RESERVED_KEYS = new Set([...APPLICANT_FIELDS, AGREE_FIELD].map((f) => f.key));

export function walkinConsentUrl(slug: string, opts: { staffId?: string | null; form?: string | null } = {}) {
  const qs = new URLSearchParams();
  if (opts.staffId) qs.set('staff', opts.staffId);
  if (opts.form) qs.set('form', opts.form);
  const tail = qs.toString();
  return `${config.WEB_BASE_URL}/consent/${encodeURIComponent(slug)}${tail ? `?${tail}` : ''}`;
}

// ---------------------------------------------------------------- lookups

/** Reception works for every open shop (it does not depend on online booking being enabled) */
async function resolveReceptionShop(slug: string) {
  const shop = await withSystem((trx) =>
    trx
      .selectFrom('shops')
      .innerJoin('organizations', 'organizations.id', 'shops.organization_id')
      .select(['shops.id', 'shops.organization_id', 'shops.name', 'shops.status', 'organizations.status as org_status'])
      .where('shops.slug', '=', slug)
      .where('shops.deleted_at', 'is', null)
      .executeTakeFirst(),
  );
  if (!shop || shop.status !== 'active' || !['active', 'trial'].includes(shop.org_status)) throw Errors.notFound('店舗');
  return { organizationId: shop.organization_id, shopId: shop.id, name: shop.name };
}

function visibleTo(shopId: string) {
  return sql<boolean>`(form_templates.shop_id IS NULL OR form_templates.shop_id = ${shopId})`;
}

/** Active consent forms a shop can use at reception: the shop's own first, then shared ones, by name */
async function consentTemplates(ctx: Ctx, shopId: string): Promise<FormTemplateRow[]> {
  return ctx.trx
    .selectFrom('form_templates')
    .selectAll()
    .where('kind', '=', 'consent')
    .where('status', '=', 'active')
    .where(visibleTo(shopId))
    .orderBy(sql`CASE WHEN shop_id IS NULL THEN 1 ELSE 0 END`)
    .orderBy('name')
    .orderBy('id')
    .execute();
}

async function receptionConsent(ctx: Ctx, shopId: string, form?: string | null): Promise<FormTemplateRow | null> {
  const all = await consentTemplates(ctx, shopId);
  if (form) return all.find((t) => t.lineage_id === form || t.id === form) ?? null;
  return all[0] ?? null;
}

/** Staff named on the QR: must still work at the shop, otherwise the intake has no staff */
async function receptionStaff(ctx: Ctx, shopId: string, staffId?: string | null) {
  if (!staffId) return null;
  const row = await ctx.trx
    .selectFrom('staffs')
    .innerJoin('staff_shop_assignments as a', 'a.staff_id', 'staffs.id')
    .select(['staffs.id', 'staffs.display_name'])
    .where('staffs.id', '=', staffId)
    .where('staffs.status', '=', 'active')
    .where('staffs.deleted_at', 'is', null)
    .where('a.shop_id', '=', shopId)
    .where('a.ended_on', 'is', null)
    .executeTakeFirst();
  return row ? { id: row.id, name: row.display_name } : null;
}

function publicForm(t: FormTemplateRow) {
  return {
    templateId: t.id,
    lineageId: t.lineage_id,
    kind: t.kind,
    name: t.name,
    version: t.version,
    fields: (Array.isArray(t.fields) ? t.fields : []) as unknown as FormField[],
    bodyMarkdown: t.body_markdown,
    requiresSignature: t.requires_signature,
  };
}

function counselingOf(row: Pick<WalkinIntakeRow, 'counseling_data'>): CounselingSheetData {
  const v = row.counseling_data;
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as CounselingSheetData) : {};
}

/** Categories with at least one answer (an untouched category is not written anywhere) */
function answeredCategories(data: CounselingSheetData): CounselingSheetData {
  const out: CounselingSheetData = {};
  for (const [category, answers] of Object.entries(data)) {
    const kept = Object.fromEntries(Object.entries(answers).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v.trim() !== '')));
    if (Object.keys(kept).length) out[category] = kept;
  }
  return out;
}

// ---------------------------------------------------------------- public (customer)

/** Reception page: shop, staff of the QR and the consent to agree to */
export async function publicWalkinView(slug: string, query: { staff?: string; form?: string }, meta: RequestMeta) {
  const shop = await resolveReceptionShop(slug);
  return withTenant(
    shop.organizationId,
    async (trx) => {
      const ctx: Ctx = { actor: systemActor(shop.organizationId, 'public:walkin'), trx, meta };
      const [consent, staff] = await Promise.all([receptionConsent(ctx, shop.shopId, query.form), receptionStaff(ctx, shop.shopId, query.staff)]);
      return { shop: { name: shop.name }, staff, consent: consent ? publicForm(consent) : null };
    },
    { traceId: meta.traceId },
  );
}

/** Customer submits their details + agreement → a pending intake; returns the token for the counselling sheet */
export async function submitWalkinConsent(slug: string, input: PublicWalkinSubmitInput, meta: RequestMeta) {
  const shop = await resolveReceptionShop(slug);
  const birthday = DateTime.fromISO(input.customer.birthday, { zone: 'utc' });
  if (!birthday.isValid || birthday.toMillis() > Date.now() || birthday.year < 1900) throw Errors.validation('生年月日が正しくありません', { issues: [{ path: 'customer.birthday', message: '生年月日が正しくありません' }] });
  return withTenant(
    shop.organizationId,
    async (trx) => {
      const ctx: Ctx = { actor: systemActor(shop.organizationId, 'public:walkin'), trx, meta };
      const template = await trx.selectFrom('form_templates').selectAll().where('id', '=', input.templateId).where('kind', '=', 'consent').where(visibleTo(shop.shopId)).executeTakeFirst();
      if (!template) throw Errors.notFound('同意書', input.templateId);
      if (template.status !== 'active') throw Errors.business('TEMPLATE_INACTIVE', '同意書の内容が更新されました。ページを読み込み直してください');
      const staff = await receptionStaff(ctx, shop.shopId, input.staffId);

      const base = snapshotOf(template);
      const clash = base.fields.find((f) => RESERVED_KEYS.has(f.key));
      if (clash) throw Errors.business('TEMPLATE_RESERVED_KEY', `同意書の項目キー「${clash.key}」は受付用に予約されています`);
      const c = input.customer;
      // the signed document = applicant details + the template's own questions + the agreement
      const snapshot: TemplateSnapshot = { ...base, fields: [...APPLICANT_FIELDS, ...base.fields, AGREE_FIELD] };
      const { answers, columns } = await prepareSubmission(
        ctx,
        snapshot,
        {
          ...input.answers,
          walkin_name: `${c.lastName} ${c.firstName}`,
          walkin_name_kana: `${c.lastNameKana} ${c.firstNameKana}`,
          walkin_birthday: c.birthday,
          walkin_phone: c.phone,
          walkin_occupation: c.occupation ?? null,
          walkin_visit_reason: c.visitReason ?? null,
          walkin_agreed: input.agreed,
        },
        input.signature,
      );
      const row = await trx
        .insertInto('walkin_intakes')
        .values({
          organization_id: shop.organizationId,
          shop_id: shop.shopId,
          staff_id: staff?.id ?? null,
          last_name: c.lastName,
          first_name: c.firstName,
          last_name_kana: c.lastNameKana,
          first_name_kana: c.firstNameKana,
          birthday: c.birthday,
          phone: c.phone,
          phone_normalized: normalizePhone(c.phone),
          occupation: c.occupation || null,
          visit_reason: c.visitReason || null,
          consent_template_id: template.id,
          consent_template_version: template.version,
          consent_snapshot: JSON.stringify(snapshot),
          consent_answers: JSON.stringify(answers),
          consent_signature_file_id: columns.signature_file_id,
          consent_signer_name: columns.signer_name,
          consent_signed_at: columns.signed_at,
          consent_submitted_at: columns.submitted_at,
          consent_document_hash: columns.document_hash,
          ip: columns.ip,
          user_agent: columns.user_agent,
        })
        .returning(['id', 'consent_submitted_at'])
        .executeTakeFirstOrThrow();
      const { token, expiresAt } = await issueAccessToken(ctx, { purpose: 'pre_visit_form', resourceType: 'walkin_intake', resourceId: row.id, ttlSec: COUNSELING_TOKEN_TTL_SEC });
      await audit(ctx, {
        action: 'walkin_intake.submit',
        resourceType: 'walkin_intake',
        resourceId: row.id,
        shopId: shop.shopId,
        metadata: { templateId: template.id, version: template.version, staffId: staff?.id ?? null, documentHash: columns.document_hash, signed: !!columns.signature_file_id },
      });
      return { ok: true as const, intakeId: row.id, submittedAt: row.consent_submitted_at, token, expiresAt };
    },
    { traceId: meta.traceId },
  );
}

/**
 * Counselling sheet filled after the consent: { <category id>: { <question id>: answer } }.
 * A category sent again replaces what was sent before; other categories are kept. If staff
 * already linked the intake, the answers go straight onto the customer's counselling sheet.
 */
export async function submitWalkinCounseling(token: string, input: PublicWalkinCounselingInput, meta: RequestMeta) {
  const t = await resolveAccessToken(token, 'pre_visit_form');
  assertTokenResource(t, 'walkin_intake');
  const data = answeredCategories(input.data);
  if (!Object.keys(data).length) throw Errors.validation('カウンセリングシートが未記入です');
  return withTenant(
    t.organizationId,
    async (trx) => {
      const ctx: Ctx = { actor: systemActor(t.organizationId, 'public:walkin'), trx, meta };
      const intake = await trx.selectFrom('walkin_intakes').selectAll().where('id', '=', t.resourceId).forUpdate().executeTakeFirst();
      if (!intake || intake.status === 'discarded') throw INVALID_LINK();
      const merged = { ...counselingOf(intake), ...data };
      const submittedAt = new Date();
      await trx
        .updateTable('walkin_intakes')
        .set({ counseling_data: JSON.stringify(merged), counseling_submitted_at: submittedAt })
        .where('id', '=', intake.id)
        .execute();
      if (intake.customer_id) await mergeIntoCounselingSheet(ctx, intake.customer_id, data, intake.shop_id);
      await audit(ctx, { action: 'walkin_intake.counseling', resourceType: 'walkin_intake', resourceId: intake.id, shopId: intake.shop_id, metadata: { categories: Object.keys(data), customerId: intake.customer_id } });
      return { ok: true as const, intakeId: intake.id, categories: Object.keys(merged), submittedAt };
    },
    { traceId: meta.traceId },
  );
}

// ---------------------------------------------------------------- staff

function fullName(r: Pick<WalkinIntakeRow, 'last_name' | 'first_name'>) {
  return `${r.last_name} ${r.first_name}`.trim();
}
function fullKana(r: Pick<WalkinIntakeRow, 'last_name_kana' | 'first_name_kana'>) {
  return `${r.last_name_kana} ${r.first_name_kana}`.trim();
}

export async function listWalkinIntakes(ctx: Ctx, input: ListWalkinIntakesInput) {
  requirePermission(ctx.actor, 'karte.read');
  assertShopAccess(ctx.actor, input.shopId);
  let q = ctx.trx
    .selectFrom('walkin_intakes as w')
    .leftJoin('staffs', 'staffs.id', 'w.staff_id')
    .select([
      'w.id',
      'w.shop_id',
      'w.staff_id',
      'staffs.display_name as staff_name',
      'w.last_name',
      'w.first_name',
      'w.last_name_kana',
      'w.first_name_kana',
      'w.phone',
      'w.birthday',
      'w.status',
      'w.customer_id',
      'w.consent_submitted_at',
      sql<boolean>`w.counseling_data <> '{}'::jsonb`.as('has_counseling'),
    ])
    .where('w.shop_id', '=', input.shopId)
    .where('w.status', '=', input.status);
  const raw = input.q?.trim();
  if (raw) {
    const term = normalizeKana(raw);
    const digits = raw.replace(/\D/g, '');
    q = q.where((eb) =>
      eb.or([
        ...(term ? [eb('w.search_text', 'like', `%${term.replace(/[\\%_]/g, '\\$&')}%`)] : []),
        ...(digits.length >= 3 ? [eb(sql`regexp_replace(coalesce(w.phone, ''), '[^0-9]', '', 'g')`, 'like', `%${digits}%`)] : []),
        ...(!term && digits.length < 3 ? [eb.lit(false)] : []),
      ]),
    );
  }
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql<boolean>`(w.consent_submitted_at, w.id) < (${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q
    .orderBy('w.consent_submitted_at', 'desc')
    .orderBy('w.id', 'desc')
    .limit(input.limit + 1)
    .execute();
  const page = paginate(rows, input.limit, (r) => r.consent_submitted_at);
  return {
    nextCursor: page.nextCursor,
    items: page.items.map((r) => ({
      id: r.id,
      shop_id: r.shop_id,
      status: r.status,
      customer_id: r.customer_id,
      customer_name: fullName(r),
      customer_name_kana: fullKana(r),
      customer_phone: r.phone,
      customer_birthday: r.birthday,
      staff_id: r.staff_id,
      staff_name: r.staff_name ?? null,
      has_counseling: !!r.has_counseling,
      consent_submitted_at: r.consent_submitted_at,
    })),
  };
}

async function loadIntake(ctx: Ctx, id: string, opts: { forUpdate?: boolean } = {}) {
  let q = ctx.trx.selectFrom('walkin_intakes').selectAll().where('id', '=', id);
  if (opts.forUpdate) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw Errors.notFound('受付', id);
  try {
    assertShopAccess(ctx.actor, row.shop_id);
  } catch {
    throw Errors.notFound('受付', id);
  }
  return row;
}

export async function getWalkinIntake(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'karte.read');
  const r = await loadIntake(ctx, id);
  const staff = r.staff_id ? await ctx.trx.selectFrom('staffs').select('display_name').where('id', '=', r.staff_id).executeTakeFirst() : null;
  let signature: { url: string; expiresAt: string; contentType: string } | null = null;
  if (r.consent_signature_file_id) {
    const f = await ctx.trx.selectFrom('files').select(['object_key', 'file_name', 'content_type']).where('id', '=', r.consent_signature_file_id).executeTakeFirst();
    if (f) signature = { ...(await signedUrlFor(f)), contentType: f.content_type };
  }
  await audit(ctx, { action: 'walkin_intake.view', resourceType: 'walkin_intake', resourceId: id, shopId: r.shop_id });
  const snapshot = r.consent_snapshot as unknown as TemplateSnapshot;
  return {
    intake: {
      id: r.id,
      shop_id: r.shop_id,
      status: r.status,
      customer_id: r.customer_id,
      customer_name: fullName(r),
      customer_name_kana: fullKana(r),
      customer_phone: r.phone,
      customer_birthday: r.birthday,
      customer_occupation: r.occupation,
      customer_visit_reason: r.visit_reason,
      staff_id: r.staff_id,
      staff_name: staff?.display_name ?? null,
      has_counseling: Object.keys(counselingOf(r)).length > 0,
      consent_submitted_at: r.consent_submitted_at,
      consent_snapshot: {
        title: snapshot.name,
        version: snapshot.version,
        body_markdown: snapshot.bodyMarkdown,
        // the template's own questions (applicant details and the agreement are shown from the columns above)
        fields: snapshot.fields.filter((f) => !RESERVED_KEYS.has(f.key)),
        answers: r.consent_answers as FieldValues,
        agreed_at: r.consent_submitted_at,
        signer_name: r.consent_signer_name,
        document_hash: r.consent_document_hash,
        signature,
      },
      counseling_data: Object.keys(counselingOf(r)).length > 0 ? counselingOf(r) : null,
      counseling_submitted_at: r.counseling_submitted_at,
    },
  };
}

/** Copy one signed sheet of the intake into the customer's form responses (already submitted → inserted as such) */
async function insertResponse(
  ctx: Ctx,
  intake: WalkinIntakeRow,
  customerId: string,
  doc: SignedDocument,
): Promise<string> {
  const row = await ctx.trx
    .insertInto('form_responses')
    .values({
      organization_id: intake.organization_id,
      template_id: doc.templateId,
      template_version: doc.version,
      template_snapshot: JSON.stringify(doc.snapshot),
      customer_id: customerId,
      shop_id: intake.shop_id,
      answers: JSON.stringify(doc.answers),
      status: 'submitted',
      submitted_via: 'customer_link',
      signature_file_id: doc.signatureFileId,
      signer_name: doc.signerName,
      signed_at: doc.signedAt,
      submitted_at: doc.submittedAt,
      document_hash: doc.documentHash,
      ip: doc.ip,
      user_agent: doc.userAgent,
      created_by: auditUserId(ctx.actor),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await afterSubmit(ctx, row, doc.answers);
  return row.id;
}

/**
 * Close the intake for a customer: the consent becomes a form response of the customer, the
 * counselling answers are written onto the customer's counselling sheet (the categories the
 * walk-in customer filled replace the same categories of the sheet).
 */
async function resolveIntake(ctx: Ctx, intake: WalkinIntakeRow, customerId: string, status: 'linked' | 'created') {
  const consentResponseId = await insertResponse(ctx, intake, customerId, {
    templateId: intake.consent_template_id,
    version: intake.consent_template_version,
    snapshot: intake.consent_snapshot as unknown as TemplateSnapshot,
    answers: intake.consent_answers as FieldValues,
    signatureFileId: intake.consent_signature_file_id,
    signerName: intake.consent_signer_name,
    signedAt: intake.consent_signed_at,
    submittedAt: intake.consent_submitted_at,
    documentHash: intake.consent_document_hash,
    ip: intake.ip,
    userAgent: intake.user_agent,
  });
  const counseling = counselingOf(intake);
  const counselingCategories = Object.keys(counseling);
  if (counselingCategories.length) await mergeIntoCounselingSheet(ctx, customerId, counseling, intake.shop_id);
  await ctx.trx
    .updateTable('walkin_intakes')
    .set({ status, customer_id: customerId, consent_response_id: consentResponseId, resolved_at: new Date(), resolved_by: auditUserId(ctx.actor) })
    .where('id', '=', intake.id)
    .execute();
  return { consentResponseId, counselingCategories };
}

function assertPending(intake: WalkinIntakeRow) {
  if (intake.status !== 'pending') throw Errors.conflict('WALKIN_ALREADY_RESOLVED', 'この受付は既に処理されています', { status: intake.status });
}

/** 既存の顧客に紐付け: consent and counselling go to the customer; blank profile fields are filled from what the customer typed */
export async function linkWalkinIntake(ctx: Ctx, id: string, customerId: string) {
  requirePermission(ctx.actor, 'karte.write');
  const intake = await loadIntake(ctx, id, { forUpdate: true });
  assertPending(intake);
  await assertCustomerAccess(ctx, customerId);
  const filled: string[] = [];
  if (can(ctx.actor, 'customer.write')) {
    const c = await ctx.trx
      .selectFrom('customers')
      .select(['last_name_kana', 'first_name_kana', 'birthday', 'phone', 'occupation', 'acquisition_source'])
      .where('id', '=', customerId)
      .executeTakeFirstOrThrow();
    const patch: Parameters<typeof updateCustomer>[2] = {};
    if (!(c.last_name_kana + c.first_name_kana).trim() && fullKana(intake)) {
      patch.lastNameKana = intake.last_name_kana;
      patch.firstNameKana = intake.first_name_kana;
    }
    if (!c.birthday && intake.birthday) patch.birthday = intake.birthday;
    if (!c.phone && intake.phone) patch.phone = intake.phone;
    if (!c.occupation && intake.occupation) patch.occupation = intake.occupation;
    if (!c.acquisition_source && intake.visit_reason) patch.acquisitionSource = intake.visit_reason;
    filled.push(...Object.keys(patch));
    if (filled.length) await updateCustomer(ctx, customerId, patch);
  }
  const res = await resolveIntake(ctx, intake, customerId, 'linked');
  await audit(ctx, { action: 'walkin_intake.link', resourceType: 'walkin_intake', resourceId: id, shopId: intake.shop_id, metadata: { customerId, filled, ...res } });
  return { ok: true as const, intakeId: id, customerId, filled, ...res };
}

/** 新規顧客として登録: a customer is created from the typed details (shop and QR staff become the primary ones) */
export async function createCustomerFromWalkinIntake(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'karte.write', 'customer.write');
  const intake = await loadIntake(ctx, id, { forUpdate: true });
  assertPending(intake);
  const { customer, duplicateCandidates } = await createCustomer(ctx, {
    lastName: intake.last_name,
    firstName: intake.first_name,
    lastNameKana: intake.last_name_kana,
    firstNameKana: intake.first_name_kana,
    birthday: intake.birthday,
    phone: intake.phone,
    occupation: intake.occupation,
    acquisitionSource: intake.visit_reason,
    primaryShopId: intake.shop_id,
    primaryStaffId: intake.staff_id,
  });
  const res = await resolveIntake(ctx, intake, customer.id, 'created');
  await audit(ctx, { action: 'walkin_intake.create_customer', resourceType: 'walkin_intake', resourceId: id, shopId: intake.shop_id, metadata: { customerId: customer.id, ...res } });
  return { ok: true as const, intakeId: id, customerId: customer.id, duplicateCandidates, ...res };
}

/** 破棄: the intake leaves the list; nothing is attached to any customer */
export async function discardWalkinIntake(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'karte.write');
  const intake = await loadIntake(ctx, id, { forUpdate: true });
  assertPending(intake);
  await ctx.trx
    .updateTable('walkin_intakes')
    .set({ status: 'discarded', resolved_at: new Date(), resolved_by: auditUserId(ctx.actor) })
    .where('id', '=', id)
    .execute();
  await audit(ctx, { action: 'walkin_intake.discard', resourceType: 'walkin_intake', resourceId: id, shopId: intake.shop_id, before: { status: 'pending' }, after: { status: 'discarded' } });
  return { ok: true as const, intakeId: id };
}

/** What the reception QR of a shop (optionally of one staff member) points at */
export async function walkinReceptionLink(ctx: Ctx, input: { shopId: string; staffId?: string }) {
  requirePermission(ctx.actor, 'karte.read');
  assertShopAccess(ctx.actor, input.shopId);
  const shop = await ctx.trx.selectFrom('shops').select(['id', 'name', 'slug', 'status']).where('id', '=', input.shopId).executeTakeFirst();
  if (!shop) throw Errors.notFound('店舗', input.shopId);
  const [staff, consents] = await Promise.all([receptionStaff(ctx, shop.id, input.staffId), consentTemplates(ctx, shop.id)]);
  if (input.staffId && !staff) throw Errors.notFound('スタッフ', input.staffId);
  return {
    url: walkinConsentUrl(shop.slug, { staffId: staff?.id }),
    shop: { id: shop.id, name: shop.name, slug: shop.slug, open: shop.status === 'active' },
    staff,
    /** the first one is used unless the URL carries ?form=<lineageId> */
    consentForms: consents.map((t) => ({ lineageId: t.lineage_id, templateId: t.id, name: t.name, version: t.version, url: walkinConsentUrl(shop.slug, { staffId: staff?.id, form: t.lineage_id }) })),
  };
}
