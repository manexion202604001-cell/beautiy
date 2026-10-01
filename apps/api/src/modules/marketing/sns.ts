import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { accessibleShopIds, assertShopAccess, auditUserId, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { sha256 } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { storage } from '../../lib/storage.js';
import { assertCustomerAccess } from '../customers/access.js';
import type { CreateSnsAssetInput, ListSnsAssetsInput } from './schemas.js';
import { renderSnsSvg } from './svg.js';

const EMBEDDABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_EMBED_BYTES = 4 * 1024 * 1024;

const assetColumns = [
  'sns_assets.id',
  'sns_assets.shop_id',
  'sns_assets.staff_id',
  'sns_assets.karte_asset_id',
  'sns_assets.review_id',
  'sns_assets.template',
  'sns_assets.caption',
  'sns_assets.hashtags',
  'sns_assets.file_id',
  'sns_assets.content',
  'sns_assets.customer_consent',
  'sns_assets.created_by',
  'sns_assets.created_at',
] as const;

/** Photo is embedded as a data: URI so the downloaded SVG is self-contained (signed URLs would expire) */
async function embedPhoto(objectKey: string, contentType: string): Promise<string | null> {
  if (!EMBEDDABLE.has(contentType)) return null;
  try {
    const head = await storage.head(objectKey);
    if (!head || head.size > MAX_EMBED_BYTES) return null;
    const buf = await storage.get(objectKey);
    return `data:${contentType};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

async function loadKartePhotos(ctx: Ctx, karteAssetId: string, template: CreateSnsAssetInput['template']) {
  requirePermission(ctx.actor, 'karte.read');
  const asset = await ctx.trx
    .selectFrom('karte_assets')
    .innerJoin('kartes', 'kartes.id', 'karte_assets.karte_id')
    .innerJoin('files', 'files.id', 'karte_assets.file_id')
    .select(['karte_assets.id', 'karte_assets.karte_id', 'karte_assets.customer_id', 'karte_assets.asset_type', 'karte_assets.object_key', 'files.content_type', 'kartes.shop_id', 'kartes.staff_id'])
    .where('karte_assets.id', '=', karteAssetId)
    .where('karte_assets.deleted_at', 'is', null)
    .where('kartes.deleted_at', 'is', null)
    .executeTakeFirst();
  if (!asset) throw Errors.notFound('カルテ写真', karteAssetId);
  await assertCustomerAccess(ctx, asset.customer_id);
  assertShopAccess(ctx.actor, asset.shop_id);
  if (!['photo', 'photo_before', 'photo_after'].includes(asset.asset_type)) throw Errors.validation('SNS素材には写真のみ使用できます');
  const assets = [asset];
  if (template === 'before_after') {
    // pair the photo with its opposite (before/after) from the same karte
    const want = asset.asset_type === 'photo_before' ? 'photo_after' : 'photo_before';
    const sibling = await ctx.trx
      .selectFrom('karte_assets')
      .innerJoin('files', 'files.id', 'karte_assets.file_id')
      .select(['karte_assets.id', 'karte_assets.karte_id', 'karte_assets.customer_id', 'karte_assets.asset_type', 'karte_assets.object_key', 'files.content_type'])
      .where('karte_assets.karte_id', '=', asset.karte_id)
      .where('karte_assets.asset_type', '=', want)
      .where('karte_assets.deleted_at', 'is', null)
      .orderBy('karte_assets.sort_order')
      .executeTakeFirst();
    if (sibling) assets.push({ ...sibling, shop_id: asset.shop_id, staff_id: asset.staff_id });
    assets.sort((a, b) => (a.asset_type === 'photo_before' ? -1 : b.asset_type === 'photo_before' ? 1 : 0));
  }
  const photos: { href: string }[] = [];
  for (const a of assets) {
    const href = await embedPhoto(a.object_key, a.content_type);
    if (href) photos.push({ href });
  }
  return { asset, photos, karteAssetIds: assets.map((a) => a.id) };
}

export async function createSnsAsset(ctx: Ctx, input: CreateSnsAssetInput) {
  requirePermission(ctx.actor, 'marketing.manage');
  if (input.template === 'review_quote' && !input.reviewId) throw Errors.validation('口コミ引用テンプレートには口コミ(reviewId)の指定が必要です');
  if (input.karteAssetId && input.customerConsent !== true) {
    throw Errors.business('CUSTOMER_CONSENT_REQUIRED', 'お客様の写真を使用するには、お客様の掲載同意(customerConsent)が必要です');
  }

  let shopId = input.shopId ?? ctx.meta.currentShopId ?? null;
  let staffId = input.staffId ?? (ctx.actor.kind === 'staff' ? ctx.actor.staffId : null);
  let photos: { href: string }[] = [];
  let karteAssetIds: string[] = [];
  if (input.karteAssetId) {
    const k = await loadKartePhotos(ctx, input.karteAssetId, input.template);
    photos = k.photos;
    karteAssetIds = k.karteAssetIds;
    shopId ??= k.asset.shop_id;
    staffId = input.staffId ?? k.asset.staff_id;
  }

  let review: { rating: number; body: string | null; reviewerName: string | null } | null = null;
  if (input.reviewId) {
    const r = await ctx.trx.selectFrom('reviews').select(['id', 'shop_id', 'staff_id', 'rating', 'body', 'reviewer_name', 'status']).where('id', '=', input.reviewId).executeTakeFirst();
    if (!r) throw Errors.notFound('口コミ', input.reviewId);
    assertShopAccess(ctx.actor, r.shop_id);
    if (r.status !== 'published') throw Errors.business('REVIEW_NOT_PUBLISHED', '公開中の口コミのみ引用できます');
    review = { rating: r.rating, body: r.body, reviewerName: r.reviewer_name };
    shopId ??= r.shop_id;
    staffId = input.staffId ?? r.staff_id ?? staffId;
  }

  if (!shopId && ctx.actor.kind === 'staff') shopId = ctx.actor.shopIds[0] ?? null;
  if (shopId) assertShopAccess(ctx.actor, shopId);
  const shop = shopId ? await ctx.trx.selectFrom('shops').select(['id', 'name']).where('id', '=', shopId).where('deleted_at', 'is', null).executeTakeFirst() : null;
  if (shopId && !shop) throw Errors.notFound('店舗', shopId);
  const org = shop ? null : await ctx.trx.selectFrom('organizations').select('name').where('id', '=', ctx.actor.organizationId).executeTakeFirstOrThrow();
  const staff = staffId ? await ctx.trx.selectFrom('staffs').select(['id', 'display_name']).where('id', '=', staffId).where('deleted_at', 'is', null).executeTakeFirst() : null;
  if (staffId && !staff) throw Errors.notFound('スタッフ', staffId);

  const svg = renderSnsSvg({
    template: input.template,
    shopName: shop?.name ?? org?.name ?? '',
    staffName: staff?.display_name ?? null,
    caption: input.caption,
    hashtags: input.hashtags,
    photos,
    review,
  });
  const body = Buffer.from(svg, 'utf8');
  const objectKey = `${ctx.actor.organizationId}/sns/${randomUUID()}.svg`;
  await storage.put(objectKey, body, 'image/svg+xml');
  const file = await ctx.trx
    .insertInto('files')
    .values({
      organization_id: ctx.actor.organizationId,
      object_key: objectKey,
      purpose: 'sns_asset',
      content_type: 'image/svg+xml',
      size_bytes: body.length,
      checksum_sha256: sha256(body),
      status: 'uploaded',
      uploaded_by: auditUserId(ctx.actor),
      uploaded_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const row = await ctx.trx
    .insertInto('sns_assets')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: shopId,
      staff_id: staffId,
      karte_asset_id: input.karteAssetId ?? null,
      review_id: input.reviewId ?? null,
      template: input.template,
      caption: input.caption,
      hashtags: input.hashtags,
      file_id: file.id,
      content: JSON.stringify({ width: 1080, height: 1080, format: 'svg', photoCount: photos.length, karteAssetIds }),
      customer_consent: input.karteAssetId ? true : input.customerConsent,
      created_by: auditUserId(ctx.actor),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await audit(ctx, {
    action: 'sns_asset.create',
    resourceType: 'sns_asset',
    resourceId: row.id,
    shopId,
    after: { template: input.template, karteAssetId: input.karteAssetId ?? null, reviewId: input.reviewId ?? null, customerConsent: input.customerConsent },
  });
  return getSnsAsset(ctx, row.id);
}

async function loadAsset(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'marketing.manage');
  const row = await ctx.trx
    .selectFrom('sns_assets')
    .leftJoin('files', 'files.id', 'sns_assets.file_id')
    .select(assetColumns)
    .select(['files.object_key', 'files.size_bytes'])
    .where('sns_assets.id', '=', id)
    .where('sns_assets.deleted_at', 'is', null)
    .executeTakeFirst();
  if (!row) throw Errors.notFound('SNS素材', id);
  assertShopAccess(ctx.actor, row.shop_id);
  return row;
}

export async function getSnsAsset(ctx: Ctx, id: string) {
  const { object_key, ...row } = await loadAsset(ctx, id);
  const downloadUrl = object_key ? await storage.presignDownload(object_key, 900, `sns-${row.template}-${id.slice(0, 8)}.svg`) : null;
  return { ...row, downloadUrl };
}

export async function listSnsAssets(ctx: Ctx, input: ListSnsAssetsInput) {
  requirePermission(ctx.actor, 'marketing.manage');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  let q = ctx.trx.selectFrom('sns_assets').select(assetColumns).where('sns_assets.deleted_at', 'is', null);
  const shops = accessibleShopIds(ctx.actor);
  if (shops) q = q.where((eb) => eb.or([eb('sns_assets.shop_id', 'is', null), eb('sns_assets.shop_id', 'in', shops.length ? [...shops] : ['00000000-0000-0000-0000-000000000000'])]));
  if (input.shopId) q = q.where('sns_assets.shop_id', '=', input.shopId);
  if (input.staffId) q = q.where('sns_assets.staff_id', '=', input.staffId);
  if (input.template) q = q.where('sns_assets.template', '=', input.template);
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql`(sns_assets.created_at, sns_assets.id)`, '<', sql`(${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('sns_assets.created_at', 'desc').orderBy('sns_assets.id', 'desc').limit(input.limit + 1).execute();
  return paginate(rows, input.limit, (r) => r.created_at);
}

export async function deleteSnsAsset(ctx: Ctx, id: string) {
  const row = await loadAsset(ctx, id);
  const now = new Date();
  await ctx.trx.updateTable('sns_assets').set({ deleted_at: now }).where('id', '=', id).execute();
  if (row.file_id) await ctx.trx.updateTable('files').set({ status: 'deleted', deleted_at: now }).where('id', '=', row.file_id).execute();
  await audit(ctx, { action: 'sns_asset.delete', resourceType: 'sns_asset', resourceId: id, shopId: row.shop_id });
  if (row.object_key) await storage.delete(row.object_key).catch(() => undefined);
}
