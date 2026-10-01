import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { sql, type Selectable } from 'kysely';
import {
  accessibleShopIds,
  assertShopAccess,
  auditUserId,
  requireAnyPermission,
  requirePermission,
  systemActor,
  type Ctx,
  type RequestMeta,
} from '../../auth/actor.js';
import { config } from '../../config.js';
import type { FormResponses, FormTemplates } from '../../db/types.js';
import { withTenant } from '../../db/tenant.js';
import { assertTokenResource, issueAccessToken, resolveAccessToken, revokeAccessTokens } from '../../lib/access-tokens.js';
import { audit, diff } from '../../lib/audit.js';
import { sha256 } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import { emit } from '../../lib/events.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { formatJst } from '../../lib/time.js';
import { assertCustomerAccess } from '../customers/access.js';
import { createFileRecord, getAttachableFile, readFileBytes, signedUrlFor, type FileRow } from '../files/api.js';
import { queueMessage } from '../messaging/api.js';
import { assertKarteReadable } from './access.js';
import { computeDocumentHash, formatFieldValue, validateFieldValues, type FieldValues } from './fields.js';
import { renderConsentHtml } from './html.js';
import type {
  CreateFormResponseInput,
  CreateFormTemplateInput,
  FormField,
  FormLinkInput,
  ListFormResponsesInput,
  PublicFormSubmitInput,
  SignatureInput,
  UpdateFormTemplateInput,
} from './schemas.js';
import { assertAppointmentFor } from './service.js';

export type FormTemplateRow = Selectable<FormTemplates>;
export type FormResponseRow = Selectable<FormResponses>;

/** Immutable copy of the template stored with every response (fields + consent body at that version) */
export interface TemplateSnapshot {
  templateId: string;
  lineageId: string;
  kind: string;
  name: string;
  version: number;
  fields: FormField[];
  bodyMarkdown: string | null;
  requiresSignature: boolean;
}

const MAX_SIGNATURE_BYTES = 1024 * 1024;
const INVALID_LINK = () => Errors.unauthenticated('リンクが無効か有効期限が切れています', 'INVALID_LINK');

function snapshotOf(t: FormTemplateRow): TemplateSnapshot {
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

function asSnapshot(v: unknown): TemplateSnapshot {
  return v as TemplateSnapshot;
}

export function formLinkUrl(token: string) {
  return `${config.WEB_BASE_URL}/f/${token}`;
}

// ---------------------------------------------------------------- templates (versioned)

export async function listFormTemplates(ctx: Ctx, input: { kind?: string; shopId?: string; includeArchived?: boolean }) {
  requireAnyPermission(ctx.actor, 'karte.read', 'form.manage', 'appointment.write');
  let q = ctx.trx.selectFrom('form_templates').selectAll();
  if (!input.includeArchived) q = q.where('status', '<>', 'archived');
  if (input.kind) q = q.where('kind', '=', input.kind);
  if (input.shopId) {
    assertShopAccess(ctx.actor, input.shopId);
    q = q.where((eb) => eb.or([eb('shop_id', 'is', null), eb('shop_id', '=', input.shopId!)]));
  } else {
    const shops = accessibleShopIds(ctx.actor);
    if (shops) q = q.where((eb) => eb.or([eb('shop_id', 'is', null), ...(shops.length ? [eb('shop_id', 'in', [...shops])] : [])]));
  }
  return q.orderBy('kind').orderBy('name').orderBy('version', 'desc').execute();
}

async function loadTemplate(ctx: Ctx, id: string, opts: { forUpdate?: boolean } = {}) {
  let q = ctx.trx.selectFrom('form_templates').selectAll().where('id', '=', id);
  if (opts.forUpdate) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  const shops = accessibleShopIds(ctx.actor);
  if (!row || (row.shop_id && shops && !shops.includes(row.shop_id))) throw Errors.notFound('フォームテンプレート', id);
  return row;
}

export async function getFormTemplate(ctx: Ctx, id: string) {
  requireAnyPermission(ctx.actor, 'karte.read', 'form.manage', 'appointment.write');
  return loadTemplate(ctx, id);
}

export async function listFormTemplateVersions(ctx: Ctx, id: string) {
  const t = await getFormTemplate(ctx, id);
  return ctx.trx.selectFrom('form_templates').selectAll().where('lineage_id', '=', t.lineage_id).orderBy('version', 'desc').execute();
}

function assertTemplateScope(ctx: Ctx, shopId: string | null | undefined) {
  if (shopId) assertShopAccess(ctx.actor, shopId);
  else if (accessibleShopIds(ctx.actor)) throw Errors.forbidden('法人共通テンプレートの管理は全店舗権限が必要です');
}

export async function createFormTemplate(ctx: Ctx, input: CreateFormTemplateInput) {
  requirePermission(ctx.actor, 'form.manage');
  assertTemplateScope(ctx, input.shopId);
  const id = randomUUID();
  const row = await ctx.trx
    .insertInto('form_templates')
    .values({
      id,
      lineage_id: id,
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId ?? null,
      kind: input.kind,
      name: input.name,
      fields: JSON.stringify(input.fields),
      body_markdown: input.bodyMarkdown ?? null,
      requires_signature: input.requiresSignature,
      status: input.status,
      version: 1,
      created_by: auditUserId(ctx.actor),
      updated_by: auditUserId(ctx.actor),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'form_template.create', resourceType: 'form_template', resourceId: row.id, shopId: row.shop_id, after: row });
  return row;
}

/**
 * Edit a template. If the current version has already been used (any response, including pending links)
 * and is not a draft, a NEW version row is created (version + 1, same lineage) and the old row is archived —
 * existing responses keep pointing at the exact version they answered. Otherwise the row is updated in place.
 */
export async function updateFormTemplate(ctx: Ctx, id: string, input: UpdateFormTemplateInput) {
  requirePermission(ctx.actor, 'form.manage');
  const before = await loadTemplate(ctx, id, { forUpdate: true });
  assertTemplateScope(ctx, before.shop_id);
  const latest = await ctx.trx
    .selectFrom('form_templates')
    .select(['id', 'version'])
    .where('lineage_id', '=', before.lineage_id)
    .orderBy('version', 'desc')
    .executeTakeFirstOrThrow();
  if (latest.id !== before.id) {
    throw Errors.conflict('TEMPLATE_SUPERSEDED', '新しい版が存在します。最新版を編集してください', { latestId: latest.id, latestVersion: latest.version });
  }

  const contentChanged =
    (input.name !== undefined && input.name !== before.name) ||
    (input.fields !== undefined && JSON.stringify(input.fields) !== JSON.stringify(before.fields)) ||
    (input.bodyMarkdown !== undefined && input.bodyMarkdown !== before.body_markdown) ||
    (input.requiresSignature !== undefined && input.requiresSignature !== before.requires_signature);

  const used = await ctx.trx.selectFrom('form_responses').select('id').where('template_id', '=', id).limit(1).executeTakeFirst();

  if (contentChanged && used && before.status !== 'draft') {
    const newId = randomUUID();
    const created = await ctx.trx
      .insertInto('form_templates')
      .values({
        id: newId,
        lineage_id: before.lineage_id,
        organization_id: before.organization_id,
        shop_id: before.shop_id,
        kind: before.kind,
        name: input.name ?? before.name,
        fields: JSON.stringify(input.fields ?? before.fields),
        body_markdown: input.bodyMarkdown !== undefined ? input.bodyMarkdown : before.body_markdown,
        requires_signature: input.requiresSignature ?? before.requires_signature,
        status: input.status && input.status !== 'archived' ? input.status : before.status === 'archived' ? 'active' : before.status,
        version: before.version + 1,
        created_by: auditUserId(ctx.actor),
        updated_by: auditUserId(ctx.actor),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await ctx.trx.updateTable('form_templates').set({ status: 'archived', updated_by: auditUserId(ctx.actor) }).where('id', '=', id).execute();
    await audit(ctx, {
      action: 'form_template.new_version',
      resourceType: 'form_template',
      resourceId: created.id,
      shopId: created.shop_id,
      metadata: { lineageId: created.lineage_id, previousId: id, previousVersion: before.version, version: created.version },
      ...diff(before, created),
    });
    return { ...created, previous_version_id: id, new_version: true };
  }

  const after = await ctx.trx
    .updateTable('form_templates')
    .set({
      name: input.name,
      fields: input.fields ? JSON.stringify(input.fields) : undefined,
      body_markdown: input.bodyMarkdown,
      requires_signature: input.requiresSignature,
      status: input.status,
      updated_by: auditUserId(ctx.actor),
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'form_template.update', resourceType: 'form_template', resourceId: id, shopId: after.shop_id, ...diff(before, after) });
  return { ...after, previous_version_id: null, new_version: false };
}

export async function archiveFormTemplate(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'form.manage');
  const before = await loadTemplate(ctx, id, { forUpdate: true });
  assertTemplateScope(ctx, before.shop_id);
  await ctx.trx.updateTable('form_templates').set({ status: 'archived', updated_by: auditUserId(ctx.actor) }).where('id', '=', id).execute();
  await audit(ctx, { action: 'form_template.archive', resourceType: 'form_template', resourceId: id, shopId: before.shop_id });
}

async function activeTemplate(ctx: Ctx, templateId: string) {
  const t = await ctx.trx.selectFrom('form_templates').selectAll().where('id', '=', templateId).executeTakeFirst();
  if (!t) throw Errors.notFound('フォームテンプレート', templateId);
  if (t.status !== 'active') throw Errors.business('TEMPLATE_INACTIVE', 'このフォームは現在使用できません(最新版を選択してください)');
  return t;
}

// ---------------------------------------------------------------- submission core

function decodeSignatureDataUrl(dataUrl: string): Buffer {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) throw Errors.validation('署名は PNG の data URL で指定してください');
  const buf = Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64');
  if (buf.length === 0) throw Errors.validation('署名が空です');
  if (buf.length > MAX_SIGNATURE_BYTES) throw Errors.validation('署名画像のサイズが大きすぎます');
  return buf;
}

async function resolveSignatureFile(ctx: Ctx, sig: { dataUrl?: string; fileId?: string }): Promise<FileRow> {
  if (sig.dataUrl) {
    return createFileRecord(ctx, { purpose: 'signature', contentType: 'image/png', body: decodeSignatureDataUrl(sig.dataUrl), fileName: 'signature.png' });
  }
  const file = await getAttachableFile(ctx, sig.fileId!, ['signature']);
  const used = await ctx.trx.selectFrom('form_responses').select('id').where('signature_file_id', '=', file.id).executeTakeFirst();
  if (used) throw Errors.conflict('SIGNATURE_ALREADY_USED', 'この署名は既に別の書類で使用されています');
  if (file.checksum_sha256) return file;
  const bytes = await readFileBytes(file);
  if (!bytes) throw Errors.business('FILE_NOT_UPLOADED', '署名ファイルを読み込めません');
  return ctx.trx.updateTable('files').set({ checksum_sha256: sha256(bytes) }).where('id', '=', file.id).returningAll().executeTakeFirstOrThrow();
}

/** Validate answers, store the signature, compute the tamper-evidence hash → columns of a submitted response */
async function prepareSubmission(ctx: Ctx, snapshot: TemplateSnapshot, rawAnswers: Record<string, unknown>, signature: { dataUrl?: string; fileId?: string; signerName: string } | undefined) {
  const answers = validateFieldValues(snapshot.fields, rawAnswers);
  if (snapshot.requiresSignature && !signature) throw Errors.business('SIGNATURE_REQUIRED', 'この書類には署名が必要です');
  const sigFile = signature ? await resolveSignatureFile(ctx, signature) : null;
  const submittedAt = new Date();
  const signedAt = sigFile ? submittedAt : null;
  const signerName = signature?.signerName.trim() || null;
  const documentHash = computeDocumentHash({
    templateSnapshot: snapshot,
    answers,
    signatureChecksum: sigFile?.checksum_sha256 ?? null,
    signerName,
    signedAt,
    submittedAt,
  });
  return {
    answers,
    columns: {
      answers: JSON.stringify(answers),
      status: 'submitted',
      signature_file_id: sigFile?.id ?? null,
      signer_name: signerName,
      signed_at: signedAt,
      submitted_at: submittedAt,
      document_hash: documentHash,
      ip: ctx.meta.ip && isIP(ctx.meta.ip) ? ctx.meta.ip : null,
      user_agent: ctx.meta.userAgent ?? null,
    },
  };
}

/** 顧客事前入力 → customers.attributes for fields with mapsTo */
async function applyAttributeMappings(ctx: Ctx, customerId: string, fields: FormField[], answers: FieldValues, responseId: string) {
  const patch: Record<string, unknown> = {};
  for (const f of fields) {
    if (!f.mapsTo) continue;
    const v = answers[f.key];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    patch[f.mapsTo] = v;
  }
  if (!Object.keys(patch).length) return;
  await ctx.trx
    .updateTable('customers')
    .set({ attributes: sql`attributes || ${JSON.stringify(patch)}::jsonb` })
    .where('id', '=', customerId)
    .execute();
  await audit(ctx, { action: 'customer.attributes_from_form', resourceType: 'customer', resourceId: customerId, after: patch, metadata: { formResponseId: responseId } });
}

async function afterSubmit(ctx: Ctx, row: FormResponseRow, answers: FieldValues) {
  const snapshot = asSnapshot(row.template_snapshot);
  await applyAttributeMappings(ctx, row.customer_id, snapshot.fields, answers, row.id);
  await audit(ctx, {
    action: 'form.submit',
    resourceType: 'form_response',
    resourceId: row.id,
    shopId: row.shop_id,
    metadata: { templateId: row.template_id, version: row.template_version, kind: snapshot.kind, via: row.submitted_via, documentHash: row.document_hash, signed: !!row.signature_file_id },
  });
  await emit(ctx, {
    type: 'form.submitted',
    aggregateType: 'form_response',
    aggregateId: row.id,
    payload: { responseId: row.id, templateId: row.template_id, kind: snapshot.kind, customerId: row.customer_id, appointmentId: row.appointment_id, karteId: row.karte_id, shopId: row.shop_id, via: row.submitted_via },
  });
}

// ---------------------------------------------------------------- staff-filled responses

export async function createFormResponse(ctx: Ctx, input: CreateFormResponseInput) {
  requirePermission(ctx.actor, 'karte.write');
  await assertCustomerAccess(ctx, input.customerId);
  const template = await activeTemplate(ctx, input.templateId);
  let shopId: string | null = null;
  if (input.appointmentId) {
    const appt = await assertAppointmentFor(ctx, input.appointmentId, input.customerId);
    assertShopAccess(ctx.actor, appt.shop_id);
    shopId = appt.shop_id;
  }
  if (input.karteId) {
    const k = await ctx.trx.selectFrom('kartes').select(['id', 'shop_id', 'customer_id']).where('id', '=', input.karteId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!k) throw Errors.notFound('カルテ', input.karteId);
    if (k.customer_id !== input.customerId) throw Errors.business('KARTE_MISMATCH', 'このカルテは指定の顧客のものではありません');
    await assertKarteReadable(ctx, k);
    shopId ??= k.shop_id;
  }
  if (template.shop_id) {
    assertShopAccess(ctx.actor, template.shop_id);
    shopId ??= template.shop_id;
  }
  shopId ??= ctx.meta.currentShopId ?? (ctx.actor.kind === 'staff' ? (ctx.actor.shopIds[0] ?? null) : null);

  const snapshot = snapshotOf(template);
  const { answers, columns } = await prepareSubmission(ctx, snapshot, input.answers, input.signature as SignatureInput | undefined);
  const row = await ctx.trx
    .insertInto('form_responses')
    .values({
      organization_id: ctx.actor.organizationId,
      template_id: template.id,
      template_version: template.version,
      template_snapshot: JSON.stringify(snapshot),
      customer_id: input.customerId,
      appointment_id: input.appointmentId ?? null,
      karte_id: input.karteId ?? null,
      shop_id: shopId,
      submitted_via: 'staff',
      created_by: auditUserId(ctx.actor),
      ...columns,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await afterSubmit(ctx, row, answers);
  return responseView(row);
}

// ---------------------------------------------------------------- customer links (事前入力 / 署名依頼)

async function issueFormLink(ctx: Ctx, args: { customerId: string; appointment: { id: string; shop_id: string; start_at: Date } | null; input: FormLinkInput }) {
  const template = await activeTemplate(ctx, args.input.templateId);
  const shopId = args.appointment?.shop_id ?? template.shop_id ?? ctx.meta.currentShopId ?? (ctx.actor.kind === 'staff' ? (ctx.actor.shopIds[0] ?? null) : null);
  const snapshot = snapshotOf(template);
  const pending = await ctx.trx
    .insertInto('form_responses')
    .values({
      organization_id: ctx.actor.organizationId,
      template_id: template.id,
      template_version: template.version,
      template_snapshot: JSON.stringify(snapshot),
      customer_id: args.customerId,
      appointment_id: args.appointment?.id ?? null,
      shop_id: shopId,
      status: 'pending',
      created_by: auditUserId(ctx.actor),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  // default lifetime: until the day after the appointment, otherwise 7 days
  let ttlSec = (args.input.expiresInDays ?? 7) * 86_400;
  if (!args.input.expiresInDays && args.appointment) {
    ttlSec = Math.max(3600, Math.floor((args.appointment.start_at.getTime() + 86_400_000 - Date.now()) / 1000));
  }
  const { token, expiresAt } = await issueAccessToken(ctx, {
    purpose: 'pre_visit_form',
    resourceType: 'form_response',
    resourceId: pending.id,
    customerId: args.customerId,
    ttlSec,
    maxUses: 1,
  });
  const url = formLinkUrl(token);
  let messageId: string | null = null;
  if (args.input.notify) {
    const shop = shopId ? await ctx.trx.selectFrom('shops').select(['name', 'timezone']).where('id', '=', shopId).executeTakeFirst() : null;
    const when = args.appointment && shop ? `(ご予約: ${formatJst(args.appointment.start_at, 'M/d HH:mm', shop.timezone)})` : '';
    const res = await queueMessage(ctx, {
      customerId: args.customerId,
      shopId,
      category: 'transactional',
      templateKey: 'form_request',
      body: `${shop?.name ?? ''}です。ご来店前に「${template.name}」のご記入をお願いいたします${when}。\n${url}`,
      vars: { url, formName: template.name, expiresAt: expiresAt.toISOString() },
      channel: args.input.channel,
      appointmentId: args.appointment?.id ?? null,
      dedupeKey: `form-link:${pending.id}`,
      sentByStaffId: auditUserId(ctx.actor),
    });
    messageId = res.messageId;
  }
  await audit(ctx, {
    action: 'form.link_issue',
    resourceType: 'form_response',
    resourceId: pending.id,
    shopId,
    metadata: { templateId: template.id, customerId: args.customerId, appointmentId: args.appointment?.id ?? null, expiresAt: expiresAt.toISOString(), notify: args.input.notify },
  });
  return { responseId: pending.id, url, expiresAt, messageId };
}

export async function createPreVisitFormLink(ctx: Ctx, appointmentId: string, input: FormLinkInput) {
  requireAnyPermission(ctx.actor, 'appointment.write', 'karte.write');
  const appt = await ctx.trx
    .selectFrom('appointments')
    .select(['id', 'shop_id', 'customer_id', 'start_at'])
    .where('id', '=', appointmentId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!appt) throw Errors.notFound('予約', appointmentId);
  assertShopAccess(ctx.actor, appt.shop_id);
  if (!appt.customer_id) throw Errors.business('APPOINTMENT_NO_CUSTOMER', 'この予約には顧客が登録されていません');
  await assertCustomerAccess(ctx, appt.customer_id);
  return issueFormLink(ctx, { customerId: appt.customer_id, appointment: appt, input });
}

export async function createCustomerFormLink(ctx: Ctx, customerId: string, input: FormLinkInput) {
  requireAnyPermission(ctx.actor, 'customer.write', 'karte.write');
  await assertCustomerAccess(ctx, customerId);
  return issueFormLink(ctx, { customerId, appointment: null, input });
}

/** Public: form to fill (template snapshot + prefilled basics). Token = authorization. */
export async function publicFormView(token: string, meta: RequestMeta) {
  const t = await resolveAccessToken(token, 'pre_visit_form');
  assertTokenResource(t, 'form_response');
  return withTenant(
    t.organizationId,
    async (trx) => {
      const resp = await trx.selectFrom('form_responses').selectAll().where('id', '=', t.resourceId).executeTakeFirst();
      if (!resp || resp.status !== 'pending') throw INVALID_LINK();
      const snapshot = asSnapshot(resp.template_snapshot);
      const [customer, shop, appt] = await Promise.all([
        trx.selectFrom('customers').select(['last_name', 'first_name', 'last_name_kana', 'first_name_kana', 'birthday', 'attributes']).where('id', '=', resp.customer_id).executeTakeFirstOrThrow(),
        resp.shop_id ? trx.selectFrom('shops').select(['name']).where('id', '=', resp.shop_id).executeTakeFirst() : null,
        resp.appointment_id ? trx.selectFrom('appointments').select(['start_at']).where('id', '=', resp.appointment_id).executeTakeFirst() : null,
      ]);
      const attrs = (customer.attributes ?? {}) as Record<string, unknown>;
      const prefill: Record<string, unknown> = {};
      for (const f of snapshot.fields) {
        if (!f.mapsTo || attrs[f.mapsTo] === undefined) continue;
        try {
          Object.assign(prefill, validateFieldValues([{ ...f, required: false }], { [f.key]: attrs[f.mapsTo] }));
        } catch {
          /* stored attribute no longer fits this field */
        }
      }
      return {
        form: { name: snapshot.name, kind: snapshot.kind, version: snapshot.version, fields: snapshot.fields, bodyMarkdown: snapshot.bodyMarkdown, requiresSignature: snapshot.requiresSignature },
        shop: shop ? { name: shop.name } : null,
        appointment: appt ? { startAt: appt.start_at } : null,
        customer: { lastName: customer.last_name, firstName: customer.first_name, lastNameKana: customer.last_name_kana, firstNameKana: customer.first_name_kana, birthday: customer.birthday },
        prefill,
      };
    },
    { traceId: meta.traceId },
  );
}

/** Public: submit answers (+ signature). Single use: token consumption and submission are atomic. */
export async function submitPublicForm(token: string, input: PublicFormSubmitInput, meta: RequestMeta) {
  const t = await resolveAccessToken(token, 'pre_visit_form');
  assertTokenResource(t, 'form_response');
  return withTenant(
    t.organizationId,
    async (trx) => {
      const ctx: Ctx = { actor: systemActor(t.organizationId, 'public:form'), trx, meta };
      const consumed = await trx
        .updateTable('access_tokens')
        .set({ use_count: sql`use_count + 1`, last_used_at: new Date() })
        .where('id', '=', t.id)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', new Date())
        .where((eb) => eb.or([eb('max_uses', 'is', null), eb('use_count', '<', eb.ref('max_uses'))]))
        .returning('id')
        .executeTakeFirst();
      if (!consumed) throw INVALID_LINK();
      const resp = await trx.selectFrom('form_responses').selectAll().where('id', '=', t.resourceId).forUpdate().executeTakeFirst();
      if (!resp || resp.status !== 'pending') throw INVALID_LINK();
      const snapshot = asSnapshot(resp.template_snapshot);
      const { answers, columns } = await prepareSubmission(ctx, snapshot, input.answers, input.signature);
      const row = await trx
        .updateTable('form_responses')
        .set({ ...columns, submitted_via: 'customer_link' })
        .where('id', '=', resp.id)
        .where('status', '=', 'pending')
        .returningAll()
        .executeTakeFirst();
      if (!row) throw INVALID_LINK();
      await afterSubmit(ctx, row, answers);
      return { ok: true as const, responseId: row.id, submittedAt: row.submitted_at, documentHash: row.document_hash };
    },
    { traceId: meta.traceId },
  );
}

// ---------------------------------------------------------------- read / verify / print / void

function responseView(r: FormResponseRow) {
  return r;
}

async function loadResponse(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'karte.read');
  const r = await ctx.trx.selectFrom('form_responses').selectAll().where('id', '=', id).executeTakeFirst();
  if (!r) throw Errors.notFound('フォーム回答', id);
  await assertCustomerAccess(ctx, r.customer_id, { allowMerged: true });
  return r;
}

export async function listFormResponses(ctx: Ctx, input: ListFormResponsesInput) {
  requirePermission(ctx.actor, 'karte.read');
  await assertCustomerAccess(ctx, input.customerId, { allowMerged: true });
  let q = ctx.trx
    .selectFrom('form_responses')
    .innerJoin('form_templates', 'form_templates.id', 'form_responses.template_id')
    .select([
      'form_responses.id',
      'form_responses.template_id',
      'form_responses.template_version',
      'form_templates.name as template_name',
      'form_templates.kind',
      'form_responses.customer_id',
      'form_responses.appointment_id',
      'form_responses.karte_id',
      'form_responses.shop_id',
      'form_responses.status',
      'form_responses.submitted_via',
      'form_responses.signer_name',
      'form_responses.signed_at',
      'form_responses.submitted_at',
      'form_responses.document_hash',
      'form_responses.voided_at',
      'form_responses.created_at',
    ])
    .where('form_responses.customer_id', '=', input.customerId);
  if (input.templateId) q = q.where('form_responses.template_id', '=', input.templateId);
  if (input.appointmentId) q = q.where('form_responses.appointment_id', '=', input.appointmentId);
  if (input.karteId) q = q.where('form_responses.karte_id', '=', input.karteId);
  if (input.kind) q = q.where('form_templates.kind', '=', input.kind);
  if (input.status) q = q.where('form_responses.status', '=', input.status);
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql`(form_responses.created_at, form_responses.id)`, '<', sql`(${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('form_responses.created_at', 'desc').orderBy('form_responses.id', 'desc').limit(input.limit + 1).execute();
  return paginate(rows, input.limit, (r) => r.created_at);
}

export async function getFormResponse(ctx: Ctx, id: string) {
  const r = await loadResponse(ctx, id);
  let signature: { url: string; expiresAt: string; contentType: string } | null = null;
  if (r.signature_file_id) {
    const f = await ctx.trx.selectFrom('files').select(['object_key', 'file_name', 'content_type']).where('id', '=', r.signature_file_id).executeTakeFirst();
    if (f) signature = { ...(await signedUrlFor(f)), contentType: f.content_type };
  }
  await audit(ctx, { action: 'form_response.view', resourceType: 'form_response', resourceId: id, shopId: r.shop_id, metadata: { customerId: r.customer_id } });
  return { ...responseView(r), signature };
}

/** Recompute the document hash from stored data and re-hash the signature bytes in storage */
export async function verifyFormResponse(ctx: Ctx, id: string) {
  const r = await loadResponse(ctx, id);
  if (r.status === 'pending') throw Errors.business('FORM_NOT_SUBMITTED', 'このフォームはまだ提出されていません');
  let sigChecksum: string | null = null;
  let signatureIntact: boolean | null = null;
  if (r.signature_file_id) {
    const f = await ctx.trx.selectFrom('files').select(['object_key', 'checksum_sha256']).where('id', '=', r.signature_file_id).executeTakeFirst();
    sigChecksum = f?.checksum_sha256 ?? null;
    const bytes = f ? await readFileBytes(f) : null;
    signatureIntact = !!bytes && !!sigChecksum && sha256(bytes) === sigChecksum;
  }
  const recomputed = computeDocumentHash({
    templateSnapshot: r.template_snapshot,
    answers: r.answers,
    signatureChecksum: sigChecksum,
    signerName: r.signer_name,
    signedAt: r.signed_at,
    submittedAt: r.submitted_at,
  });
  const hashMatches = recomputed === r.document_hash;
  const valid = hashMatches && signatureIntact !== false;
  await audit(ctx, { action: 'form_response.verify', resourceType: 'form_response', resourceId: id, shopId: r.shop_id, metadata: { valid } });
  return {
    valid,
    status: r.status,
    documentHash: r.document_hash,
    recomputedHash: recomputed,
    hashMatches,
    signature: r.signature_file_id ? { present: true, intact: signatureIntact, checksum: sigChecksum } : { present: false, intact: null, checksum: null },
    verifiedAt: new Date().toISOString(),
  };
}

export async function formResponseHtml(ctx: Ctx, id: string) {
  const r = await loadResponse(ctx, id);
  if (r.status === 'pending') throw Errors.business('FORM_NOT_SUBMITTED', 'このフォームはまだ提出されていません');
  const snapshot = asSnapshot(r.template_snapshot);
  const answers = (r.answers ?? {}) as Record<string, unknown>;
  const [customer, shop, sigFile] = await Promise.all([
    ctx.trx.selectFrom('customers').select(['last_name', 'first_name']).where('id', '=', r.customer_id).executeTakeFirstOrThrow(),
    r.shop_id ? ctx.trx.selectFrom('shops').select(['name', 'timezone']).where('id', '=', r.shop_id).executeTakeFirst() : null,
    r.signature_file_id ? ctx.trx.selectFrom('files').select(['object_key', 'file_name']).where('id', '=', r.signature_file_id).executeTakeFirst() : null,
  ]);
  const tz = shop?.timezone ?? 'Asia/Tokyo';
  const html = renderConsentHtml({
    title: snapshot.name,
    version: snapshot.version,
    shopName: shop?.name ?? null,
    customerName: `${customer.last_name} ${customer.first_name}`.trim(),
    bodyMarkdown: snapshot.bodyMarkdown,
    answers: snapshot.fields.map((f) => ({ label: f.label, value: formatFieldValue(answers[f.key]) })),
    signatureUrl: sigFile ? (await signedUrlFor(sigFile, { ttlSec: 3600 })).url : null,
    signerName: r.signer_name,
    signedAt: r.signed_at ? formatJst(r.signed_at, 'yyyy年M月d日 HH:mm', tz) : null,
    submittedAt: r.submitted_at ? formatJst(r.submitted_at, 'yyyy年M月d日 HH:mm', tz) : null,
    submittedVia: r.submitted_via,
    documentHash: r.document_hash,
    voided: r.status === 'voided' ? { reason: r.void_reason, at: r.voided_at ? formatJst(r.voided_at, 'yyyy年M月d日 HH:mm', tz) : null } : null,
  });
  await audit(ctx, { action: 'form_response.print', resourceType: 'form_response', resourceId: id, shopId: r.shop_id });
  return html;
}

export async function voidFormResponse(ctx: Ctx, id: string, reason: string) {
  requirePermission(ctx.actor, 'form.manage');
  const r = await loadResponse(ctx, id);
  if (r.shop_id) assertShopAccess(ctx.actor, r.shop_id);
  if (r.status === 'voided') throw Errors.conflict('ALREADY_VOIDED', 'この書類は既に無効化されています');
  const after = await ctx.trx
    .updateTable('form_responses')
    .set({ status: 'voided', voided_at: new Date(), voided_by: auditUserId(ctx.actor), void_reason: reason })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
  if (r.status === 'pending') await revokeAccessTokens(ctx, 'form_response', id, 'pre_visit_form');
  await audit(ctx, { action: 'form_response.void', resourceType: 'form_response', resourceId: id, shopId: r.shop_id, before: { status: r.status }, after: { status: 'voided' }, metadata: { reason } });
  return responseView(after);
}
