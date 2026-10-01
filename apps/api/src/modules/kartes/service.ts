import { sql, type Selectable } from 'kysely';
import { assertShopAccess, auditUserId, requirePermission, systemActor, type Ctx, type RequestMeta } from '../../auth/actor.js';
import { config } from '../../config.js';
import type { Kartes } from '../../db/types.js';
import { withTenant } from '../../db/tenant.js';
import { assertTokenResource, issueAccessToken, resolveAccessToken, revokeAccessTokens } from '../../lib/access-tokens.js';
import { audit, diff } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { emit } from '../../lib/events.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { formatJst, localDate } from '../../lib/time.js';
import { assertCustomerAccess, visibleCustomerFilter } from '../customers/access.js';
import { getAttachableFile, markFileDeleted, signedUrlFor, type FilePurpose } from '../files/api.js';
import { queueMessage } from '../messaging/api.js';
import { assertKarteReadable, assertKarteWritable, karteShopFilter } from './access.js';
import { formatFieldValue, validateFieldValues, validateFreeFields, type FieldValues } from './fields.js';
import type {
  Chemical,
  CreateAssetInput,
  CreateKarteInput,
  DuplicateKarteInput,
  Homecare,
  ListKartesInput,
  ShareKarteInput,
  UpdateAssetInput,
  UpdateKarteInput,
} from './schemas.js';
import { templateFields, usableKarteTemplate } from './templates.js';

export type KarteRow = Selectable<Kartes>;

/** customer-facing share links default lifetime is set per share; signed asset URLs are short-lived */
const PUBLIC_ASSET_URL_TTL_SEC = 60 * 60;

// ---------------------------------------------------------------- helpers

async function loadKarte(ctx: Ctx, id: string, opts: { forUpdate?: boolean } = {}) {
  let q = ctx.trx.selectFrom('kartes').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
  if (opts.forUpdate) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw Errors.notFound('カルテ', id);
  return row;
}

async function loadShop(ctx: Ctx, shopId: string) {
  const shop = await ctx.trx.selectFrom('shops').select(['id', 'name', 'timezone']).where('id', '=', shopId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!shop) throw Errors.notFound('店舗', shopId);
  return shop;
}

async function assertStaff(ctx: Ctx, staffId: string) {
  const s = await ctx.trx.selectFrom('staffs').select('id').where('id', '=', staffId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!s) throw Errors.validation('担当スタッフが見つかりません', { staffId });
}

/** The appointment must belong to the same customer and shop as the karte */
export async function assertAppointmentFor(ctx: Ctx, appointmentId: string, customerId: string, shopId?: string) {
  const appt = await ctx.trx
    .selectFrom('appointments')
    .select(['id', 'customer_id', 'shop_id', 'start_at', 'staff_id'])
    .where('id', '=', appointmentId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!appt) throw Errors.notFound('予約', appointmentId);
  if (appt.customer_id !== customerId || (shopId && appt.shop_id !== shopId)) {
    throw Errors.business('APPOINTMENT_MISMATCH', 'この予約は指定の顧客・店舗のものではありません');
  }
  return appt;
}

function chemicalsToDb(list: Chemical[]) {
  return list.map((c) => ({
    name: c.name.trim(),
    brand: c.brand ?? null,
    ratio: c.ratio ?? null,
    processing_min: c.processingMin ?? null,
    note: c.note ?? null,
  }));
}

function chemicalsFromDb(value: unknown): Chemical[] {
  return (Array.isArray(value) ? value : []).map((c: Record<string, unknown>) => ({
    name: String(c.name ?? ''),
    brand: (c.brand as string | null) ?? null,
    ratio: (c.ratio as string | null) ?? null,
    processingMin: (c.processing_min as number | null) ?? null,
    note: (c.note as string | null) ?? null,
  }));
}

function homecareFromDb(value: unknown): { advice: string | null; product_ids: string[] } {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return { advice: (v.advice as string | null) ?? null, product_ids: Array.isArray(v.product_ids) ? (v.product_ids as string[]) : [] };
}

async function homecareToDb(ctx: Ctx, input: Homecare) {
  const productIds = [...new Set(input.productIds ?? [])];
  if (productIds.length) {
    const found = await ctx.trx.selectFrom('products').select('id').where('id', 'in', productIds).where('deleted_at', 'is', null).execute();
    const missing = productIds.filter((id) => !found.some((f) => f.id === id));
    if (missing.length) throw Errors.validation('おすすめ商品が見つかりません', { productIds: missing });
  }
  return { advice: input.advice?.trim() || null, product_ids: productIds };
}

async function productsFor(ctx: Ctx, ids: string[]) {
  if (!ids.length) return [];
  const rows = await ctx.trx
    .selectFrom('products')
    .select(['id', 'name', 'brand', 'price', 'price_tax_included', 'image_file_ids'])
    .where('id', 'in', ids)
    .where('deleted_at', 'is', null)
    .execute();
  return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => !!r);
}

async function resolveFields(ctx: Ctx, templateId: string | null, shopId: string, values: Record<string, unknown>, legacyKeys?: ReadonlySet<string>): Promise<FieldValues> {
  if (!templateId) return validateFreeFields(values);
  const template = await usableKarteTemplate(ctx, templateId, shopId);
  return validateFieldValues(templateFields(template), values, { allowExtraKeys: legacyKeys });
}

// ---------------------------------------------------------------- views

type AssetRow = {
  id: string;
  karte_id: string;
  file_id: string;
  object_key: string;
  asset_type: string;
  caption: string | null;
  share_with_customer: boolean;
  sort_order: number;
  created_at: Date;
  created_by: string | null;
  content_type: string;
  file_name: string | null;
};

function assetQuery(ctx: Ctx) {
  return ctx.trx
    .selectFrom('karte_assets')
    .innerJoin('files', 'files.id', 'karte_assets.file_id')
    .select([
      'karte_assets.id',
      'karte_assets.karte_id',
      'karte_assets.file_id',
      'karte_assets.object_key',
      'karte_assets.asset_type',
      'karte_assets.caption',
      'karte_assets.share_with_customer',
      'karte_assets.sort_order',
      'karte_assets.created_at',
      'karte_assets.created_by',
      'files.content_type',
      'files.file_name',
    ])
    .where('karte_assets.deleted_at', 'is', null)
    .where('files.status', '=', 'uploaded');
}

async function assetView(a: AssetRow, ttlSec?: number) {
  const signed = await signedUrlFor({ object_key: a.object_key, file_name: a.file_name }, { ttlSec });
  const { object_key: _k, ...rest } = a;
  return { ...rest, url: signed.url, url_expires_at: signed.expiresAt };
}

async function karteDetail(ctx: Ctx, k: KarteRow) {
  const [staff, template, assets] = await Promise.all([
    ctx.trx.selectFrom('staffs').select(['id', 'display_name']).where('id', '=', k.staff_id).executeTakeFirst(),
    k.template_id ? ctx.trx.selectFrom('karte_templates').select(['id', 'name', 'category', 'fields', 'status']).where('id', '=', k.template_id).executeTakeFirst() : null,
    assetQuery(ctx).where('karte_assets.karte_id', '=', k.id).orderBy('karte_assets.sort_order').orderBy('karte_assets.created_at').execute(),
  ]);
  const homecare = homecareFromDb(k.homecare);
  return {
    ...k,
    staff_name: staff?.display_name ?? null,
    template: template ?? null,
    assets: await Promise.all(assets.map((a) => assetView(a))),
    homecare_products: (await productsFor(ctx, homecare.product_ids)).map((p) => ({ id: p.id, name: p.name, brand: p.brand, price: p.price, price_tax_included: p.price_tax_included })),
  };
}

// ---------------------------------------------------------------- CRUD

export async function createKarte(ctx: Ctx, input: CreateKarteInput) {
  requirePermission(ctx.actor, 'karte.write');
  assertShopAccess(ctx.actor, input.shopId);
  await assertCustomerAccess(ctx, input.customerId);
  const shop = await loadShop(ctx, input.shopId);

  let staffId = input.staffId ?? null;
  let visitDate = input.visitDate;
  if (input.appointmentId) {
    const appt = await assertAppointmentFor(ctx, input.appointmentId, input.customerId, input.shopId);
    visitDate ??= localDate(appt.start_at, shop.timezone);
    staffId ??= appt.staff_id;
  }
  staffId ??= ctx.actor.kind === 'staff' ? ctx.actor.staffId : null;
  if (!staffId) throw Errors.validation('担当スタッフを指定してください');
  await assertStaff(ctx, staffId);
  visitDate ??= localDate(new Date(), shop.timezone);

  const templateId = input.templateId ?? null;
  let fields: FieldValues;
  if (templateId) {
    const t = await usableKarteTemplate(ctx, templateId, input.shopId);
    if (t.status !== 'active') throw Errors.validation('このテンプレートは現在使用できません');
    fields = validateFieldValues(templateFields(t), input.fields);
  } else {
    fields = validateFreeFields(input.fields);
  }
  const homecare = await homecareToDb(ctx, input.homecare);

  const row = await ctx.trx
    .insertInto('kartes')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId,
      customer_id: input.customerId,
      appointment_id: input.appointmentId ?? null,
      staff_id: staffId,
      template_id: templateId,
      visit_date: visitDate,
      fields: JSON.stringify(fields),
      chemicals: JSON.stringify(chemicalsToDb(input.chemicals)),
      note: input.note ?? null,
      homecare: JSON.stringify(homecare),
      created_by: auditUserId(ctx.actor),
      updated_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'karte.create', resourceType: 'karte', resourceId: row.id, shopId: row.shop_id, after: row });
  await emit(ctx, { type: 'karte.created', aggregateType: 'karte', aggregateId: row.id, payload: { karteId: row.id, customerId: row.customer_id, shopId: row.shop_id } });
  return karteDetail(ctx, row);
}

export async function listKartes(ctx: Ctx, input: ListKartesInput) {
  requirePermission(ctx.actor, 'karte.read');
  let q = ctx.trx
    .selectFrom('kartes')
    .leftJoin('staffs', 'staffs.id', 'kartes.staff_id')
    .leftJoin('karte_templates', 'karte_templates.id', 'kartes.template_id')
    .leftJoin('customers as kc', 'kc.id', 'kartes.customer_id')
    .selectAll('kartes')
    .select([
      'staffs.display_name as staff_name',
      'karte_templates.name as template_name',
      sql<string>`coalesce(nullif(trim(kc.last_name || ' ' || kc.first_name), ''), trim(kc.last_name_kana || ' ' || kc.first_name_kana))`.as('customer_name'),
      (eb) =>
        eb
          .selectFrom('karte_assets')
          .select(sql<number>`count(*)::int`.as('n'))
          .whereRef('karte_assets.karte_id', '=', 'kartes.id')
          .where('karte_assets.deleted_at', 'is', null)
          .as('asset_count'),
    ])
    .where('kartes.deleted_at', 'is', null);

  if (input.customerId) {
    await assertCustomerAccess(ctx, input.customerId, { allowMerged: true });
    q = q.where('kartes.customer_id', '=', input.customerId);
  } else {
    const filter = visibleCustomerFilter(ctx);
    if (filter) {
      q = q.where((eb) =>
        eb.exists(
          eb
            .selectFrom('customers')
            .select(sql`1`.as('x'))
            .whereRef('customers.id', '=', 'kartes.customer_id')
            .where(filter as never),
        ),
      );
    }
  }
  const shops = karteShopFilter(ctx);
  if (input.shopId) {
    if (shops && !shops.includes(input.shopId)) assertShopAccess(ctx.actor, input.shopId);
    q = q.where('kartes.shop_id', '=', input.shopId);
  } else if (shops) {
    q = q.where('kartes.shop_id', 'in', shops.length ? [...shops] : ['00000000-0000-0000-0000-000000000000']);
  }
  if (input.staffId) q = q.where('kartes.staff_id', '=', input.staffId);
  if (input.appointmentId) q = q.where('kartes.appointment_id', '=', input.appointmentId);
  if (input.from) q = q.where('kartes.visit_date', '>=', input.from);
  if (input.to) q = q.where('kartes.visit_date', '<=', input.to);
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql`(kartes.visit_date, kartes.id)`, '<', sql`(${cursor.v}::date, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('kartes.visit_date', 'desc').orderBy('kartes.id', 'desc').limit(input.limit + 1).execute();
  return paginate(rows, input.limit, (r) => r.visit_date);
}

export async function getKarte(ctx: Ctx, id: string) {
  const k = await loadKarte(ctx, id);
  await assertKarteReadable(ctx, k);
  await audit(ctx, { action: 'karte.view', resourceType: 'karte', resourceId: id, shopId: k.shop_id, metadata: { customerId: k.customer_id } });
  return karteDetail(ctx, k);
}

export async function updateKarte(ctx: Ctx, id: string, input: UpdateKarteInput) {
  const before = await loadKarte(ctx, id, { forUpdate: true });
  await assertKarteWritable(ctx, before);
  if (before.version !== input.version) {
    throw Errors.conflict('VERSION_CONFLICT', '他のスタッフがこのカルテを更新しました。最新の内容を確認してください', { currentVersion: before.version });
  }
  const templateId = input.templateId !== undefined ? input.templateId : before.template_id;
  const templateChanged = templateId !== before.template_id;
  let fields: FieldValues | undefined;
  if (input.fields !== undefined || templateChanged) {
    const values = (input.fields ?? before.fields ?? {}) as Record<string, unknown>;
    // keys already stored on this karte survive template edits (legacy fields) as long as the template is unchanged
    const legacy = templateChanged ? undefined : new Set(Object.keys((before.fields ?? {}) as object));
    fields = await resolveFields(ctx, templateId, before.shop_id, values, legacy);
  }
  if (input.appointmentId) await assertAppointmentFor(ctx, input.appointmentId, before.customer_id, before.shop_id);
  if (input.staffId) await assertStaff(ctx, input.staffId);
  const homecare = input.homecare ? await homecareToDb(ctx, input.homecare) : undefined;

  const after = await ctx.trx
    .updateTable('kartes')
    .set({
      template_id: input.templateId,
      appointment_id: input.appointmentId,
      staff_id: input.staffId,
      visit_date: input.visitDate,
      fields: fields ? JSON.stringify(fields) : undefined,
      chemicals: input.chemicals ? JSON.stringify(chemicalsToDb(input.chemicals)) : undefined,
      note: input.note,
      homecare: homecare ? JSON.stringify(homecare) : undefined,
      version: before.version + 1,
      updated_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .where('id', '=', id)
    .where('version', '=', input.version)
    .returningAll()
    .executeTakeFirst();
  if (!after) throw Errors.conflict('VERSION_CONFLICT', '他のスタッフがこのカルテを更新しました。最新の内容を確認してください');
  await audit(ctx, { action: 'karte.update', resourceType: 'karte', resourceId: id, shopId: after.shop_id, ...diff(before, after) });
  return karteDetail(ctx, after);
}

export async function deleteKarte(ctx: Ctx, id: string) {
  const k = await loadKarte(ctx, id, { forUpdate: true });
  await assertKarteWritable(ctx, k);
  await ctx.trx.updateTable('kartes').set({ deleted_at: new Date(), shared_with_customer: false, updated_by: auditUserId(ctx.actor) }).where('id', '=', id).execute();
  await revokeAccessTokens(ctx, 'karte', id, 'karte_share');
  await audit(ctx, { action: 'karte.delete', resourceType: 'karte', resourceId: id, shopId: k.shop_id, before: k });
}

/** 前回カルテ: most recent visible karte of the customer (optionally same template) */
export async function latestKarte(ctx: Ctx, customerId: string, opts: { templateId?: string; shopId?: string } = {}) {
  requirePermission(ctx.actor, 'karte.read');
  await assertCustomerAccess(ctx, customerId, { allowMerged: true });
  let q = ctx.trx.selectFrom('kartes').selectAll().where('customer_id', '=', customerId).where('deleted_at', 'is', null);
  const shops = karteShopFilter(ctx);
  if (shops) q = q.where('shop_id', 'in', shops.length ? [...shops] : ['00000000-0000-0000-0000-000000000000']);
  if (opts.templateId) q = q.where('template_id', '=', opts.templateId);
  if (opts.shopId) q = q.where('shop_id', '=', opts.shopId);
  const k = await q.orderBy('visit_date', 'desc').orderBy('created_at', 'desc').executeTakeFirst();
  if (!k) return { karte: null };
  await audit(ctx, { action: 'karte.view', resourceType: 'karte', resourceId: k.id, shopId: k.shop_id, metadata: { customerId, via: 'latest' } });
  return { karte: await karteDetail(ctx, k) };
}

/** 前回カルテ複製: copy template, fields, chemicals and homecare into a new karte (photos/notes are not copied) */
export async function duplicateKarte(ctx: Ctx, sourceId: string, input: DuplicateKarteInput) {
  const src = await loadKarte(ctx, sourceId);
  await assertKarteReadable(ctx, src);
  const shopId = input.shopId ?? src.shop_id;
  let templateId = src.template_id;
  let fields = (src.fields ?? {}) as FieldValues;
  if (templateId) {
    const t = await ctx.trx.selectFrom('karte_templates').select(['id', 'status', 'shop_id', 'fields']).where('id', '=', templateId).executeTakeFirst();
    if (!t || t.status !== 'active' || (t.shop_id && t.shop_id !== shopId)) {
      templateId = null;
    } else {
      // keep only keys of the current template version
      const keys = new Set(templateFields(t).map((f) => f.key));
      fields = Object.fromEntries(Object.entries(fields).filter(([k]) => keys.has(k)));
    }
  }
  const homecare = homecareFromDb(src.homecare);
  const created = await createKarte(ctx, {
    customerId: src.customer_id,
    shopId,
    appointmentId: input.appointmentId ?? null,
    staffId: input.staffId ?? null,
    templateId,
    visitDate: input.visitDate,
    fields,
    chemicals: chemicalsFromDb(src.chemicals),
    note: input.includeNote ? src.note : null,
    homecare: { advice: homecare.advice, productIds: homecare.product_ids },
  });
  return { ...created, duplicated_from: src.id };
}

// ---------------------------------------------------------------- assets

const ASSET_PURPOSES: Record<CreateAssetInput['assetType'], FilePurpose[]> = {
  photo_before: ['karte_photo'],
  photo_after: ['karte_photo'],
  photo: ['karte_photo'],
  sketch: ['sketch', 'karte_photo'],
  document: ['document', 'karte_photo'],
};

export async function addAsset(ctx: Ctx, karteId: string, input: CreateAssetInput) {
  const k = await loadKarte(ctx, karteId);
  await assertKarteWritable(ctx, k);
  const file = await getAttachableFile(ctx, input.fileId, ASSET_PURPOSES[input.assetType]);
  const used = await ctx.trx.selectFrom('karte_assets').select('id').where('file_id', '=', file.id).where('deleted_at', 'is', null).executeTakeFirst();
  if (used) throw Errors.conflict('FILE_ALREADY_ATTACHED', 'このファイルは既に添付されています');
  let sortOrder = input.sortOrder;
  if (sortOrder === undefined) {
    const max = await ctx.trx
      .selectFrom('karte_assets')
      .select(sql<number>`coalesce(max(sort_order), -1)::int`.as('m'))
      .where('karte_id', '=', karteId)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    sortOrder = max.m + 1;
  }
  const row = await ctx.trx
    .insertInto('karte_assets')
    .values({
      organization_id: ctx.actor.organizationId,
      karte_id: karteId,
      customer_id: k.customer_id,
      file_id: file.id,
      object_key: file.object_key,
      asset_type: input.assetType,
      caption: input.caption ?? null,
      share_with_customer: input.shareWithCustomer,
      sort_order: sortOrder,
      created_by: auditUserId(ctx.actor),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'karte.asset_add', resourceType: 'karte', resourceId: karteId, shopId: k.shop_id, metadata: { assetId: row.id, fileId: file.id, assetType: input.assetType } });
  return assetView(await assetQuery(ctx).where('karte_assets.id', '=', row.id).executeTakeFirstOrThrow());
}

export async function listAssets(ctx: Ctx, karteId: string) {
  const k = await loadKarte(ctx, karteId);
  await assertKarteReadable(ctx, k);
  const rows = await assetQuery(ctx).where('karte_assets.karte_id', '=', karteId).orderBy('karte_assets.sort_order').orderBy('karte_assets.created_at').execute();
  return Promise.all(rows.map((a) => assetView(a)));
}

async function loadAsset(ctx: Ctx, karteId: string, assetId: string) {
  const a = await ctx.trx
    .selectFrom('karte_assets')
    .selectAll()
    .where('id', '=', assetId)
    .where('karte_id', '=', karteId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!a) throw Errors.notFound('カルテ画像', assetId);
  return a;
}

export async function updateAsset(ctx: Ctx, karteId: string, assetId: string, input: UpdateAssetInput) {
  const k = await loadKarte(ctx, karteId);
  await assertKarteWritable(ctx, k);
  const before = await loadAsset(ctx, karteId, assetId);
  if (input.assetType) {
    const file = await ctx.trx.selectFrom('files').select('purpose').where('id', '=', before.file_id).executeTakeFirstOrThrow();
    if (!ASSET_PURPOSES[input.assetType].includes(file.purpose as FilePurpose)) throw Errors.validation('このファイルはこの種別に変更できません');
  }
  const after = await ctx.trx
    .updateTable('karte_assets')
    .set({ caption: input.caption, share_with_customer: input.shareWithCustomer, sort_order: input.sortOrder, asset_type: input.assetType })
    .where('id', '=', assetId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'karte.asset_update', resourceType: 'karte', resourceId: karteId, shopId: k.shop_id, metadata: { assetId }, ...diff(before, after) });
  return assetView(await assetQuery(ctx).where('karte_assets.id', '=', assetId).executeTakeFirstOrThrow());
}

export async function deleteAsset(ctx: Ctx, karteId: string, assetId: string) {
  const k = await loadKarte(ctx, karteId);
  await assertKarteWritable(ctx, k);
  const a = await loadAsset(ctx, karteId, assetId);
  await ctx.trx.updateTable('karte_assets').set({ deleted_at: new Date() }).where('id', '=', assetId).execute();
  await markFileDeleted(ctx, a.file_id);
  await audit(ctx, { action: 'karte.asset_delete', resourceType: 'karte', resourceId: karteId, shopId: k.shop_id, metadata: { assetId, fileId: a.file_id } });
}

// ---------------------------------------------------------------- sharing with the customer

export function karteShareUrl(token: string) {
  return `${config.WEB_BASE_URL}/k/${token}`;
}

export async function shareKarte(ctx: Ctx, karteId: string, input: ShareKarteInput) {
  const k = await loadKarte(ctx, karteId, { forUpdate: true });
  await assertKarteWritable(ctx, k);
  const shop = await loadShop(ctx, k.shop_id);
  // one active link per karte: re-sharing rotates the token
  await revokeAccessTokens(ctx, 'karte', karteId, 'karte_share');
  const { token, id: tokenId, expiresAt } = await issueAccessToken(ctx, {
    purpose: 'karte_share',
    resourceType: 'karte',
    resourceId: karteId,
    customerId: k.customer_id,
    ttlSec: input.expiresInDays * 86_400,
  });
  const sharedAt = new Date();
  await ctx.trx.updateTable('kartes').set({ shared_with_customer: true, shared_at: sharedAt }).where('id', '=', karteId).execute();
  const url = karteShareUrl(token);

  let messageId: string | null = null;
  if (input.notify) {
    const res = await queueMessage(ctx, {
      customerId: k.customer_id,
      shopId: k.shop_id,
      category: 'transactional',
      templateKey: 'karte_shared',
      body: `${shop.name}です。ご来店ありがとうございました。\n本日の施術写真とホームケアのご案内をお送りします。\n${url}\n(閲覧期限: ${formatJst(expiresAt, 'yyyy/MM/dd', shop.timezone)})`,
      vars: { url, expiresAt: expiresAt.toISOString(), shopName: shop.name },
      channel: input.channel,
      appointmentId: k.appointment_id,
      dedupeKey: `karte-share:${tokenId}`,
      sentByStaffId: auditUserId(ctx.actor),
    });
    messageId = res.messageId;
  }
  await audit(ctx, { action: 'karte.share', resourceType: 'karte', resourceId: karteId, shopId: k.shop_id, metadata: { expiresAt: expiresAt.toISOString(), notify: input.notify, messageId } });
  await emit(ctx, { type: 'karte.shared', aggregateType: 'karte', aggregateId: karteId, payload: { karteId, customerId: k.customer_id, shopId: k.shop_id } });
  return { url, expiresAt, sharedAt, messageId };
}

export async function unshareKarte(ctx: Ctx, karteId: string) {
  const k = await loadKarte(ctx, karteId, { forUpdate: true });
  await assertKarteWritable(ctx, k);
  await revokeAccessTokens(ctx, 'karte', karteId, 'karte_share');
  await ctx.trx.updateTable('kartes').set({ shared_with_customer: false }).where('id', '=', karteId).execute();
  await audit(ctx, { action: 'karte.unshare', resourceType: 'karte', resourceId: karteId, shopId: k.shop_id });
}

/**
 * Customer-safe projection: visit date, shop, staff display name, customer-visible template fields,
 * assets flagged for sharing (signed URLs), homecare advice and recommended products (name/price).
 * Never includes internal notes, chemicals or non-visible fields.
 */
export async function customerSafeKarte(ctx: Ctx, k: KarteRow) {
  const [shop, staff, template, assets] = await Promise.all([
    ctx.trx.selectFrom('shops').select(['id', 'name']).where('id', '=', k.shop_id).executeTakeFirstOrThrow(),
    ctx.trx.selectFrom('staffs').select(['display_name']).where('id', '=', k.staff_id).executeTakeFirst(),
    k.template_id ? ctx.trx.selectFrom('karte_templates').select(['name', 'fields']).where('id', '=', k.template_id).executeTakeFirst() : null,
    assetQuery(ctx)
      .where('karte_assets.karte_id', '=', k.id)
      .where('karte_assets.share_with_customer', '=', true)
      .orderBy('karte_assets.sort_order')
      .orderBy('karte_assets.created_at')
      .execute(),
  ]);
  const values = (k.fields ?? {}) as Record<string, unknown>;
  const visibleFields = template
    ? templateFields(template)
        .filter((f) => f.customerVisible && values[f.key] !== undefined && values[f.key] !== null && values[f.key] !== '')
        .map((f) => ({ key: f.key, label: f.label, value: values[f.key], display: formatFieldValue(values[f.key]) }))
    : [];
  const homecare = homecareFromDb(k.homecare);
  const products = await productsFor(ctx, homecare.product_ids);
  return {
    id: k.id,
    visitDate: k.visit_date,
    sharedAt: k.shared_at,
    shop: { id: shop.id, name: shop.name },
    staff: { displayName: staff?.display_name ?? null },
    title: template?.name ?? null,
    fields: visibleFields,
    assets: await Promise.all(
      assets.map(async (a) => {
        const signed = await signedUrlFor({ object_key: a.object_key, file_name: a.file_name }, { ttlSec: PUBLIC_ASSET_URL_TTL_SEC });
        return { id: a.id, assetType: a.asset_type, caption: a.caption, contentType: a.content_type, url: signed.url, urlExpiresAt: signed.expiresAt };
      }),
    ),
    homecare: {
      advice: homecare.advice,
      products: products.map((p) => ({ id: p.id, name: p.name, brand: p.brand, price: p.price, priceTaxIncluded: p.price_tax_included })),
    },
  };
}

/** Public share page (token = authorization). Stops working after revoke, expiry, unshare or deletion. */
export async function karteShareView(token: string, meta: RequestMeta) {
  const t = await resolveAccessToken(token, 'karte_share');
  assertTokenResource(t, 'karte');
  return withTenant(
    t.organizationId,
    async (trx) => {
      const ctx: Ctx = { actor: systemActor(t.organizationId, 'public:karte_share'), trx, meta };
      const k = await ctx.trx.selectFrom('kartes').selectAll().where('id', '=', t.resourceId).where('deleted_at', 'is', null).executeTakeFirst();
      if (!k || !k.shared_with_customer) throw Errors.unauthenticated('リンクが無効か有効期限が切れています', 'INVALID_LINK');
      return customerSafeKarte(ctx, k);
    },
    { traceId: meta.traceId },
  );
}

/** Authenticated customer (LINE/OTP): kartes shared with them */
export async function listCustomerKartes(ctx: Ctx, customerId: string) {
  const rows = await ctx.trx
    .selectFrom('kartes')
    .selectAll()
    .where('customer_id', '=', customerId)
    .where('shared_with_customer', '=', true)
    .where('deleted_at', 'is', null)
    .orderBy('visit_date', 'desc')
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute();
  return Promise.all(rows.map((k) => customerSafeKarte(ctx, k)));
}

export async function getCustomerKarte(ctx: Ctx, customerId: string, karteId: string) {
  const k = await ctx.trx
    .selectFrom('kartes')
    .selectAll()
    .where('id', '=', karteId)
    .where('customer_id', '=', customerId)
    .where('shared_with_customer', '=', true)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!k) throw Errors.notFound('カルテ', karteId);
  return customerSafeKarte(ctx, k);
}
