// Electronic karte services: one karte per appointment, templates, copy-previous,
// photos, sketch, customer share links, counseling forms and self-entry responses.
import { z } from 'zod';
import { Prisma } from '@salonos/db';
import { randomToken } from '@salonos/core/crypto';
import { prisma } from './db';
import { audit } from './audit';
import { deleteObject, objectKey, putObject, readUpload } from './storage';
import { AppError, NotFoundError } from './errors';
import type { Actor } from './crm';

// ───────────────────────── Karte ─────────────────────────

const note = z.string().max(10000, '10,000文字以内で入力してください').optional().nullable().transform((v) => (v?.trim() ? v.replace(/\r\n/g, '\n') : null));

/** Sketch JSON: normalized (0..1) stroke points so it re-renders at any canvas size. */
export const sketchSchema = z.object({
  v: z.literal(1),
  bg: z.enum(['head', 'blank']).default('head'),
  strokes: z.array(z.object({
    c: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    w: z.number().min(0.5).max(60),
    e: z.boolean().optional(),
    p: z.array(z.tuple([z.number().min(-0.1).max(1.1), z.number().min(-0.1).max(1.1)])).min(1).max(5000),
  })).max(1500),
});
export type SketchData = z.infer<typeof sketchSchema>;

export function parseSketch(raw: string | null | undefined): SketchData | null {
  if (!raw || !raw.trim()) return null;
  if (raw.length > 1_500_000) throw new AppError('スケッチのデータが大きすぎます。一部を消去してください。');
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new AppError('スケッチのデータが不正です'); }
  const r = sketchSchema.safeParse(json);
  if (!r.success) throw new AppError('スケッチのデータが不正です');
  // round coordinates to keep the row compact
  return { ...r.data, strokes: r.data.strokes.map((s) => ({ ...s, p: s.p.map(([x, y]) => [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000] as [number, number]) })) };
}

export const karteFieldsSchema = z.object({
  treatmentNote: note, formulaNote: note, assistantNote: note, careMemo: note,
  visitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '来店日を入力してください').optional().nullable(),
  sketchJson: z.string().optional().nullable(),
});
export type KarteFields = z.input<typeof karteFieldsSchema>;

function visitDateFrom(s: string | null | undefined, fallback: Date): Date {
  if (!s) return fallback;
  // noon JST keeps the calendar date stable across timezones
  const d = new Date(`${s}T12:00:00+09:00`);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function sketchValue(raw: string | null | undefined) {
  if (raw === undefined) return undefined;
  const s = parseSketch(raw);
  return s && s.strokes.length ? (s as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
}

export interface CreateKarteInput extends KarteFields { customerId?: string | null; appointmentId?: string | null; shopId: string }

/**
 * Create a karte. With an appointment, enforces one karte per appointment: if one exists
 * (including a concurrent insert racing on the unique index) returns it with existing=true.
 */
export async function createKarte(actor: Actor, input: CreateKarteInput): Promise<{ id: string; existing: boolean }> {
  const f = karteFieldsSchema.parse(input);
  let customerId = input.customerId ?? null;
  let shopId = input.shopId;
  let visitDate = new Date();
  if (input.appointmentId) {
    const appt = await prisma.appointment.findFirst({ where: { id: input.appointmentId, organizationId: actor.orgId }, include: { karte: { select: { id: true } } } });
    if (!appt) throw new NotFoundError('予約が見つかりません');
    if (appt.karte) return { id: appt.karte.id, existing: true };
    if (!appt.customerId) throw new AppError('この予約には顧客が紐づいていません。先に顧客を登録してください。');
    if (customerId && customerId !== appt.customerId) throw new AppError('予約と顧客が一致しません');
    customerId = appt.customerId;
    shopId = appt.shopId;
    visitDate = appt.startAt;
  }
  if (!customerId) throw new AppError('顧客を選択してください');
  const c = await prisma.customer.findFirst({ where: { id: customerId, organizationId: actor.orgId, mergedIntoId: null, deletedAt: null } });
  if (!c) throw new NotFoundError('顧客が見つかりません');
  const shop = await prisma.shop.findFirst({ where: { id: shopId, organizationId: actor.orgId } });
  if (!shop) throw new NotFoundError('店舗が見つかりません');
  try {
    const k = await prisma.karte.create({
      data: {
        organizationId: actor.orgId, shopId, customerId, appointmentId: input.appointmentId ?? null, authorId: actor.userId,
        visitDate: visitDateFrom(f.visitDate, visitDate),
        treatmentNote: f.treatmentNote, formulaNote: f.formulaNote, assistantNote: f.assistantNote, careMemo: f.careMemo,
        sketchJson: sketchValue(f.sketchJson ?? null),
      },
    });
    await audit(actor, 'karte.create', 'Karte', k.id, { customerId, appointmentId: input.appointmentId ?? null });
    return { id: k.id, existing: false };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && input.appointmentId) {
      const k = await prisma.karte.findUnique({ where: { appointmentId: input.appointmentId } });
      if (k) return { id: k.id, existing: true };
    }
    throw e;
  }
}

export async function getKarte(orgId: string, id: string) {
  const k = await prisma.karte.findFirst({
    where: { id, organizationId: orgId },
    include: {
      photos: { orderBy: { createdAt: 'asc' } },
      customer: { select: { id: true, lastName: true, firstName: true, lastNameKana: true, firstNameKana: true, notes: true, mergedIntoId: true, deletedAt: true } },
      appointment: { select: { id: true, startAt: true, endAt: true, status: true, menus: { select: { name: true } } } },
      author: { select: { id: true, name: true } },
    },
  });
  if (!k) throw new NotFoundError('カルテが見つかりません');
  return k;
}

export async function updateKarte(actor: Actor, id: string, input: KarteFields) {
  const f = karteFieldsSchema.parse(input);
  const k = await prisma.karte.findFirst({ where: { id, organizationId: actor.orgId } });
  if (!k) throw new NotFoundError('カルテが見つかりません');
  await prisma.karte.update({
    where: { id },
    data: {
      treatmentNote: f.treatmentNote, formulaNote: f.formulaNote, assistantNote: f.assistantNote, careMemo: f.careMemo,
      ...(f.visitDate ? { visitDate: visitDateFrom(f.visitDate, k.visitDate) } : {}),
      ...(input.sketchJson !== undefined ? { sketchJson: sketchValue(f.sketchJson ?? null) } : {}),
    },
  });
  await audit(actor, 'karte.update', 'Karte', id);
}

export async function deleteKarte(actor: Actor, id: string) {
  const k = await prisma.karte.findFirst({ where: { id, organizationId: actor.orgId }, include: { photos: true } });
  if (!k) throw new NotFoundError('カルテが見つかりません');
  for (const p of k.photos) await deleteObject(p.storageKey).catch((e) => console.error('[karte.delete] object', e));
  await prisma.karte.delete({ where: { id } });
  await audit(actor, 'karte.delete', 'Karte', id, { customerId: k.customerId, photos: k.photos.length });
  return k.customerId;
}

/** The customer's most recent karte before `before` (excluding `excludeId`). */
export async function previousKarte(orgId: string, customerId: string, opts: { before?: Date; excludeId?: string } = {}) {
  return prisma.karte.findFirst({
    where: {
      organizationId: orgId, customerId,
      ...(opts.excludeId ? { NOT: { id: opts.excludeId } } : {}),
      ...(opts.before ? { visitDate: { lte: opts.before } } : {}),
    },
    orderBy: [{ visitDate: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, visitDate: true, treatmentNote: true, formulaNote: true, assistantNote: true, careMemo: true },
  });
}

/** Copy text fields of the previous karte into `karteId` (server-side variant of the editor button). */
export async function copyFromPrevious(actor: Actor, karteId: string) {
  const k = await prisma.karte.findFirst({ where: { id: karteId, organizationId: actor.orgId } });
  if (!k) throw new NotFoundError('カルテが見つかりません');
  const prev = await previousKarte(actor.orgId, k.customerId, { before: k.visitDate, excludeId: k.id });
  if (!prev) throw new AppError('コピーできる前回のカルテがありません');
  await prisma.karte.update({
    where: { id: k.id },
    data: { treatmentNote: prev.treatmentNote, formulaNote: prev.formulaNote, assistantNote: prev.assistantNote, careMemo: prev.careMemo },
  });
  return prev.id;
}

// ── photos ──

export const PHOTO_KINDS = ['BEFORE', 'AFTER', 'OTHER'] as const;
export const PHOTO_KIND_LABEL: Record<string, string> = { BEFORE: 'ビフォー', AFTER: 'アフター', OTHER: 'その他' };
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif']);

export async function addKartePhotos(actor: Actor, karteId: string, files: File[], meta: { kind: string; caption?: string | null; shareable: boolean }) {
  const k = await prisma.karte.findFirst({ where: { id: karteId, organizationId: actor.orgId }, select: { id: true, _count: { select: { photos: true } } } });
  if (!k) throw new NotFoundError('カルテが見つかりません');
  const kind = (PHOTO_KINDS as readonly string[]).includes(meta.kind) ? meta.kind : 'OTHER';
  const real = files.filter((f) => f && typeof f !== 'string' && f.size > 0);
  if (!real.length) throw new AppError('写真を選択してください');
  if (real.length > 10) throw new AppError('一度にアップロードできるのは10枚までです');
  if (k._count.photos + real.length > 40) throw new AppError('1つのカルテに保存できる写真は40枚までです');
  const created: string[] = [];
  for (const f of real) {
    const up = await readUpload(f);
    if (!up) continue;
    if (!PHOTO_TYPES.has(up.contentType)) throw new AppError('画像ファイル（JPEG/PNG/WebP/HEIC/GIF）を選択してください');
    const key = objectKey(actor.orgId, 'karte', up.ext);
    await putObject(actor.orgId, key, up.data, up.contentType);
    const p = await prisma.kartePhoto.create({
      data: { karteId, kind, storageKey: key, contentType: up.contentType, size: up.data.byteLength, caption: meta.caption?.trim().slice(0, 200) || null, shareable: meta.shareable },
    });
    created.push(p.id);
  }
  await audit(actor, 'karte.photo.add', 'Karte', karteId, { count: created.length, kind });
  return created;
}

export async function updateKartePhoto(actor: Actor, photoId: string, data: { shareable?: boolean; caption?: string | null; kind?: string }) {
  const p = await prisma.kartePhoto.findFirst({ where: { id: photoId, karte: { organizationId: actor.orgId } } });
  if (!p) throw new NotFoundError('写真が見つかりません');
  await prisma.kartePhoto.update({
    where: { id: p.id },
    data: {
      ...(data.shareable !== undefined ? { shareable: data.shareable } : {}),
      ...(data.caption !== undefined ? { caption: data.caption?.trim().slice(0, 200) || null } : {}),
      ...(data.kind && (PHOTO_KINDS as readonly string[]).includes(data.kind) ? { kind: data.kind } : {}),
    },
  });
  return p.karteId;
}

export async function deleteKartePhoto(actor: Actor, photoId: string) {
  const p = await prisma.kartePhoto.findFirst({ where: { id: photoId, karte: { organizationId: actor.orgId } } });
  if (!p) throw new NotFoundError('写真が見つかりません');
  await prisma.kartePhoto.delete({ where: { id: p.id } });
  await deleteObject(p.storageKey).catch((e) => console.error('[karte.photo.delete] object', e));
  await audit(actor, 'karte.photo.delete', 'Karte', p.karteId, { photoId: p.id });
  return p.karteId;
}

// ── share ──

export async function setKarteShare(actor: Actor, karteId: string, enabled: boolean, opts: { regenerate?: boolean } = {}) {
  const k = await prisma.karte.findFirst({ where: { id: karteId, organizationId: actor.orgId } });
  if (!k) throw new NotFoundError('カルテが見つかりません');
  const token = enabled ? (opts.regenerate || !k.shareToken ? randomToken(18) : k.shareToken) : k.shareToken;
  const updated = await prisma.karte.update({
    where: { id: k.id },
    data: { shareEnabled: enabled, shareToken: token, ...(enabled ? { sharedAt: new Date() } : {}) },
  });
  await audit(actor, enabled ? 'karte.share.enable' : 'karte.share.disable', 'Karte', k.id, { regenerated: !!opts.regenerate });
  return updated;
}

/**
 * Public, customer-facing projection of a shared karte. Internal notes, author email
 * and customer PII are never selected. Returns null unless the link is enabled.
 */
export async function getSharedKarte(token: string) {
  if (!token || token.length < 16 || token.length > 64) return null;
  const k = await prisma.karte.findFirst({
    where: { shareToken: token, shareEnabled: true, customer: { deletedAt: null } },
    select: {
      id: true, organizationId: true, shopId: true, authorId: true, visitDate: true, careMemo: true, shareToken: true,
      photos: { where: { shareable: true }, orderBy: { createdAt: 'asc' }, select: { id: true, kind: true, storageKey: true, caption: true } },
    },
  });
  if (!k) return null;
  const [shop, org, author] = await Promise.all([
    prisma.shop.findUnique({ where: { id: k.shopId }, select: { name: true, slug: true, timezone: true, imageUrl: true } }),
    prisma.organization.findUnique({ where: { id: k.organizationId }, select: { name: true } }),
    prisma.membership.findFirst({ where: { organizationId: k.organizationId, userId: k.authorId }, select: { displayName: true, imageUrl: true } }),
  ]);
  return {
    visitDate: k.visitDate, careMemo: k.careMemo, token: k.shareToken!,
    photos: k.photos, shop, orgName: org?.name ?? '', stylist: author ? { name: author.displayName, imageUrl: author.imageUrl } : null,
  };
}

// ───────────────────────── Templates ─────────────────────────

export const templateSchema = z.object({
  name: z.string().trim().min(1, 'テンプレート名を入力してください').max(60),
  treatmentNote: note, formulaNote: note, careMemo: note,
});

export async function saveKarteTemplate(actor: Actor, id: string | null, input: z.input<typeof templateSchema>) {
  const d = templateSchema.parse(input);
  if (id) {
    const t = await prisma.karteTemplate.findFirst({ where: { id, organizationId: actor.orgId } });
    if (!t) throw new NotFoundError('テンプレートが見つかりません');
    return prisma.karteTemplate.update({ where: { id }, data: d });
  }
  return prisma.karteTemplate.create({ data: { organizationId: actor.orgId, ...d } });
}

export async function deleteKarteTemplate(actor: Actor, id: string) {
  const r = await prisma.karteTemplate.deleteMany({ where: { id, organizationId: actor.orgId } });
  if (!r.count) throw new NotFoundError('テンプレートが見つかりません');
}

// ───────────────────────── Counseling forms ─────────────────────────

export const FIELD_TYPES = ['text', 'textarea', 'select', 'multiselect', 'checkbox', 'date'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: '1行テキスト', textarea: '複数行テキスト', select: '単一選択', multiselect: '複数選択', checkbox: 'チェック（はい/いいえ）', date: '日付',
};

export const formFieldSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/, '項目IDが不正です'),
  label: z.string().trim().min(1, '項目名を入力してください').max(120),
  type: z.enum(FIELD_TYPES),
  options: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  required: z.boolean().optional(),
  help: z.string().trim().max(300).optional(),
});
export type FormField = z.infer<typeof formFieldSchema>;

export const formSchema = z.object({
  name: z.string().trim().min(1, 'フォーム名を入力してください').max(80),
  description: z.string().trim().max(1000).optional().nullable().transform((v) => v || null),
  fields: z.array(formFieldSchema).min(1, '項目を1つ以上追加してください').max(60),
  requireConsent: z.boolean(),
  consentText: z.string().trim().max(5000).optional().nullable().transform((v) => v || null),
  active: z.boolean(),
}).superRefine((f, ctx) => {
  const ids = new Set<string>();
  f.fields.forEach((x, i) => {
    if (ids.has(x.id)) ctx.addIssue({ code: 'custom', path: ['fields', i, 'id'], message: `項目IDが重複しています（${x.label}）` });
    ids.add(x.id);
    if ((x.type === 'select' || x.type === 'multiselect') && !(x.options && x.options.length >= 1)) {
      ctx.addIssue({ code: 'custom', path: ['fields', i, 'options'], message: `「${x.label}」の選択肢を入力してください` });
    }
  });
  if (f.requireConsent && !f.consentText) ctx.addIssue({ code: 'custom', path: ['consentText'], message: '同意文を入力してください' });
});

export function parseFormFields(json: unknown): FormField[] {
  const r = z.array(formFieldSchema).safeParse(json);
  return r.success ? r.data : [];
}

export async function saveCounselingForm(actor: Actor, id: string | null, input: z.input<typeof formSchema>) {
  const d = formSchema.parse(input);
  const data = { ...d, fields: d.fields.map((f) => ({ ...f, options: f.type === 'select' || f.type === 'multiselect' ? f.options : undefined })) as unknown as Prisma.InputJsonValue };
  if (id) {
    const f = await prisma.counselingForm.findFirst({ where: { id, organizationId: actor.orgId } });
    if (!f) throw new NotFoundError('フォームが見つかりません');
    return prisma.counselingForm.update({ where: { id }, data });
  }
  return prisma.counselingForm.create({ data: { organizationId: actor.orgId, ...data } });
}

export async function deleteCounselingForm(actor: Actor, id: string) {
  const f = await prisma.counselingForm.findFirst({ where: { id, organizationId: actor.orgId }, include: { _count: { select: { responses: true } } } });
  if (!f) throw new NotFoundError('フォームが見つかりません');
  if (f._count.responses > 0) {
    // keep submitted records (consent evidence): archive instead of delete
    await prisma.counselingForm.update({ where: { id }, data: { active: false } });
    return 'archived' as const;
  }
  await prisma.counselingForm.delete({ where: { id } });
  return 'deleted' as const;
}

/** Issue a customer self-entry link (PENDING response with an unguessable token). */
export async function issueCounselingLink(actor: Actor, input: { formId: string; customerId?: string | null; appointmentId?: string | null }) {
  const form = await prisma.counselingForm.findFirst({ where: { id: input.formId, organizationId: actor.orgId, active: true } });
  if (!form) throw new NotFoundError('フォームが見つかりません');
  let customerId = input.customerId ?? null;
  if (input.appointmentId) {
    const a = await prisma.appointment.findFirst({ where: { id: input.appointmentId, organizationId: actor.orgId } });
    if (!a) throw new NotFoundError('予約が見つかりません');
    if (customerId && a.customerId && a.customerId !== customerId) throw new AppError('予約と顧客が一致しません');
    customerId = customerId ?? a.customerId;
  }
  if (customerId) {
    const c = await prisma.customer.findFirst({ where: { id: customerId, organizationId: actor.orgId, mergedIntoId: null, deletedAt: null } });
    if (!c) throw new NotFoundError('顧客が見つかりません');
  }
  const r = await prisma.counselingResponse.create({
    data: { organizationId: actor.orgId, formId: form.id, customerId, appointmentId: input.appointmentId ?? null, token: randomToken(18) },
  });
  await audit(actor, 'counseling.issue', 'CounselingResponse', r.id, { formId: form.id, customerId });
  return r;
}

export async function getCounselingByToken(token: string) {
  if (!token || token.length < 16 || token.length > 64) return null;
  const r = await prisma.counselingResponse.findUnique({
    where: { token },
    include: { form: true, customer: { select: { deletedAt: true } } },
  });
  if (!r || r.customer?.deletedAt) return null;
  const org = await prisma.organization.findUnique({ where: { id: r.organizationId }, select: { name: true } });
  const shop = r.appointmentId
    ? await prisma.appointment.findUnique({ where: { id: r.appointmentId }, select: { startAt: true, shop: { select: { name: true, timezone: true } } } })
    : null;
  return {
    id: r.id, status: r.status as 'PENDING' | 'SUBMITTED', submittedAt: r.submittedAt,
    form: { name: r.form.name, description: r.form.description, fields: parseFormFields(r.form.fields), requireConsent: r.form.requireConsent, consentText: r.form.consentText, active: r.form.active },
    orgName: org?.name ?? '', shopName: shop?.shop.name ?? null, appointmentAt: shop?.startAt ?? null, timezone: shop?.shop.timezone ?? 'Asia/Tokyo',
  };
}

export type Answers = Record<string, string | string[] | boolean | null>;

/** Validate raw answers against the form definition. Returns cleaned answers or field errors. */
export function validateAnswers(fields: FormField[], raw: Record<string, unknown>): { answers: Answers; errors: Record<string, string> } {
  const answers: Answers = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = raw[f.id];
    switch (f.type) {
      case 'text': case 'textarea': {
        const s = typeof v === 'string' ? v.trim() : '';
        if (s.length > (f.type === 'text' ? 500 : 3000)) errors[f.id] = `「${f.label}」が長すぎます`;
        answers[f.id] = s || null;
        if (f.required && !s) errors[f.id] = `「${f.label}」を入力してください`;
        break;
      }
      case 'date': {
        const s = typeof v === 'string' ? v.trim() : '';
        if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) errors[f.id] = `「${f.label}」の日付が正しくありません`;
        answers[f.id] = s || null;
        if (f.required && !s) errors[f.id] = `「${f.label}」を入力してください`;
        break;
      }
      case 'select': {
        const s = typeof v === 'string' ? v : '';
        if (s && !(f.options ?? []).includes(s)) errors[f.id] = `「${f.label}」の選択肢が不正です`;
        answers[f.id] = s || null;
        if (f.required && !s) errors[f.id] = `「${f.label}」を選択してください`;
        break;
      }
      case 'multiselect': {
        const arr = (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []).filter((x): x is string => typeof x === 'string');
        const uniq = [...new Set(arr)];
        if (uniq.some((x) => !(f.options ?? []).includes(x))) errors[f.id] = `「${f.label}」の選択肢が不正です`;
        answers[f.id] = uniq;
        if (f.required && !uniq.length) errors[f.id] = `「${f.label}」を1つ以上選択してください`;
        break;
      }
      case 'checkbox': {
        const b = v === true || v === 'on' || v === 'true' || v === '1';
        answers[f.id] = b;
        if (f.required && !b) errors[f.id] = `「${f.label}」にチェックしてください`;
        break;
      }
    }
  }
  return { answers, errors };
}

const SIGNATURE_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;

export interface SubmitCounselingInput { answers: Record<string, unknown>; signatureData?: string | null; signedName?: string | null; consent?: boolean }

export class CounselingValidationError extends AppError {
  constructor(public fieldErrors: Record<string, string>) { super('入力内容を確認してください'); }
}

/** Customer submits the self-entry form. Single-use: only a PENDING response can be submitted. */
export async function submitCounseling(token: string, input: SubmitCounselingInput) {
  const r = await prisma.counselingResponse.findUnique({ where: { token }, include: { form: true, customer: { select: { deletedAt: true } } } });
  if (!r || r.customer?.deletedAt) throw new NotFoundError('フォームが見つかりません');
  if (r.status === 'SUBMITTED') throw new AppError('このフォームは既に送信済みです');
  const fields = parseFormFields(r.form.fields);
  const { answers, errors } = validateAnswers(fields, input.answers);
  const signedName = input.signedName?.normalize('NFKC').trim().slice(0, 60) || null;
  const sig = input.signatureData?.trim() || null;
  if (sig && (!SIGNATURE_RE.test(sig) || sig.length > 400_000)) errors._signature = '署名データが不正です。もう一度署名してください。';
  if (r.form.requireConsent) {
    if (!input.consent) errors._consent = '同意事項を確認し、チェックを入れてください';
    if (!sig) errors._signature = errors._signature ?? '署名をお願いします';
    if (!signedName) errors._signedName = 'お名前（署名）を入力してください';
  }
  if (Object.keys(errors).length) throw new CounselingValidationError(errors);
  const now = new Date();
  const res = await prisma.counselingResponse.updateMany({
    where: { id: r.id, status: 'PENDING' },
    data: {
      status: 'SUBMITTED', answers: answers as Prisma.InputJsonValue, signatureData: sig, signedName,
      signedAt: sig || signedName ? now : null, submittedAt: now,
    },
  });
  if (res.count === 0) throw new AppError('このフォームは既に送信済みです');
  await audit({ orgId: r.organizationId, userId: null }, 'counseling.submit', 'CounselingResponse', r.id, { formId: r.formId, customerId: r.customerId, consent: !!input.consent });
  return r.id;
}

/** Render answers for staff display. */
export function formatAnswer(f: FormField, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (f.type === 'checkbox') return v ? 'はい' : 'いいえ';
  if (Array.isArray(v)) return v.length ? v.join('、') : '—';
  return String(v);
}
