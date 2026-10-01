import { sql } from 'kysely';
import { accessibleShopIds, assertShopAccess, auditUserId, can, hasShopAccess, requireAnyPermission, requirePermission, systemActor, type Ctx, type RequestMeta } from '../../auth/actor.js';
import { config } from '../../config.js';
import { withSystem, withTenant } from '../../db/tenant.js';
import { audit, diff } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { toInclusive } from '../../lib/money.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { storage } from '../../lib/storage.js';
import { assertCustomerAccess } from '../customers/access.js';
import { ensureReferralLink, referralUrl } from '../marketing/api.js';
import { queueMessage } from '../messaging/api.js';
import type { CreateProductInput, ListProductsInput, StockAdjustmentInput, UpdateProductInput } from './schemas.js';
import { applyStockMovement } from './stock.js';

const NO_SHOP = '00000000-0000-0000-0000-000000000000';

export const productColumns = [
  'products.id',
  'products.shop_id',
  'products.sku',
  'products.barcode',
  'products.name',
  'products.brand',
  'products.category',
  'products.description',
  'products.price',
  'products.price_tax_included',
  'products.cost',
  'products.tax_rate_bp',
  'products.image_file_ids',
  'products.is_online',
  'products.stock_managed',
  'products.status',
  'products.created_at',
  'products.updated_at',
] as const;

/** Tax-inclusive unit price (総額表示) */
export function inclusivePrice(p: { price: number; price_tax_included: boolean; tax_rate_bp: number }): number {
  return p.price_tax_included ? p.price : toInclusive(p.price, p.tax_rate_bp);
}

function visibleProducts(ctx: Ctx) {
  const shops = accessibleShopIds(ctx.actor);
  if (!shops) return null;
  const ids = shops.length ? [...shops] : [NO_SHOP];
  return ids;
}

async function imageUrls(ctx: Ctx, fileIds: string[], ttlSec = 3600): Promise<{ fileId: string; url: string }[]> {
  if (!fileIds.length) return [];
  const files = await ctx.trx.selectFrom('files').select(['id', 'object_key']).where('id', 'in', fileIds).where('status', '=', 'uploaded').execute();
  const byId = new Map(files.map((f) => [f.id, f.object_key]));
  const out: { fileId: string; url: string }[] = [];
  for (const id of fileIds) {
    const key = byId.get(id);
    if (key) out.push({ fileId: id, url: await storage.presignDownload(key, ttlSec) });
  }
  return out;
}

async function assertUnique(ctx: Ctx, input: { sku?: string | null; barcode?: string | null }, exceptId?: string) {
  for (const field of ['sku', 'barcode'] as const) {
    const value = input[field];
    if (!value) continue;
    let q = ctx.trx.selectFrom('products').select('id').where(field, '=', value).where('deleted_at', 'is', null);
    if (exceptId) q = q.where('id', '!=', exceptId);
    if (await q.executeTakeFirst()) {
      throw Errors.conflict(field === 'sku' ? 'SKU_DUPLICATE' : 'BARCODE_DUPLICATE', field === 'sku' ? 'このSKUは既に使用されています' : 'このバーコードは既に使用されています', { [field]: value });
    }
  }
}

async function assertFiles(ctx: Ctx, fileIds: string[] | undefined) {
  if (!fileIds?.length) return;
  const unique = [...new Set(fileIds)];
  const found = await ctx.trx.selectFrom('files').select('id').where('id', 'in', unique).where('deleted_at', 'is', null).execute();
  if (found.length !== unique.length) throw Errors.validation('商品画像のファイルが見つかりません');
}

export async function loadProduct(ctx: Ctx, id: string) {
  const p = await ctx.trx.selectFrom('products').select(productColumns).where('products.id', '=', id).where('products.deleted_at', 'is', null).executeTakeFirst();
  if (!p || !hasShopAccess(ctx.actor, p.shop_id)) throw Errors.notFound('商品', id);
  return p;
}

async function stocksFor(ctx: Ctx, productIds: string[]) {
  const map = new Map<string, { shop_id: string | null; quantity: number; reorder_point: number | null }[]>();
  if (!productIds.length) return map;
  let q = ctx.trx.selectFrom('product_stocks').select(['product_id', 'shop_id', 'quantity', 'reorder_point']).where('product_id', 'in', productIds);
  const shops = visibleProducts(ctx);
  if (shops) q = q.where((eb) => eb.or([eb('shop_id', 'is', null), eb('shop_id', 'in', shops)]));
  for (const s of await q.orderBy(sql`shop_id NULLS FIRST`).execute()) {
    const list = map.get(s.product_id) ?? [];
    list.push({ shop_id: s.shop_id, quantity: s.quantity, reorder_point: s.reorder_point });
    map.set(s.product_id, list);
  }
  return map;
}

// ---------------------------------------------------------------- CRUD

export async function createProduct(ctx: Ctx, input: CreateProductInput) {
  requirePermission(ctx.actor, 'product.manage');
  if (input.shopId) {
    assertShopAccess(ctx.actor, input.shopId);
    if (!(await ctx.trx.selectFrom('shops').select('id').where('id', '=', input.shopId).where('deleted_at', 'is', null).executeTakeFirst())) throw Errors.notFound('店舗', input.shopId);
  }
  await assertUnique(ctx, input);
  await assertFiles(ctx, input.imageFileIds);
  const row = await ctx.trx
    .insertInto('products')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId ?? null,
      sku: input.sku ?? null,
      barcode: input.barcode ?? null,
      name: input.name,
      brand: input.brand ?? null,
      category: input.category ?? null,
      description: input.description ?? null,
      price: input.price,
      price_tax_included: input.priceTaxIncluded,
      cost: input.cost ?? null,
      tax_rate_bp: input.taxRateBp,
      image_file_ids: input.imageFileIds,
      is_online: input.isOnline,
      stock_managed: input.stockManaged,
      status: input.status,
      created_by: auditUserId(ctx.actor),
      updated_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const product = await loadProduct(ctx, row.id);
  await audit(ctx, { action: 'product.create', resourceType: 'product', resourceId: row.id, shopId: product.shop_id, after: product });
  return getProduct(ctx, row.id);
}

export async function listProducts(ctx: Ctx, input: ListProductsInput) {
  requireAnyPermission(ctx.actor, 'product.manage', 'pos.read', 'pos.operate');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  let q = ctx.trx.selectFrom('products').select(productColumns).where('products.deleted_at', 'is', null);
  const shops = visibleProducts(ctx);
  if (shops) q = q.where((eb) => eb.or([eb('products.shop_id', 'is', null), eb('products.shop_id', 'in', shops)]));
  if (input.shopId) q = q.where((eb) => eb.or([eb('products.shop_id', 'is', null), eb('products.shop_id', '=', input.shopId!)]));
  if (input.q) {
    const term = `%${input.q.replace(/[%_\\]/g, '\\$&')}%`;
    q = q.where((eb) => eb.or([eb('products.name', 'ilike', term), eb('products.sku', 'ilike', term), eb('products.brand', 'ilike', term), eb('products.barcode', '=', input.q!)]));
  }
  if (input.category) q = q.where('products.category', '=', input.category);
  if (input.barcode) q = q.where('products.barcode', '=', input.barcode);
  if (input.isOnline !== undefined) q = q.where('products.is_online', '=', input.isOnline);
  if (input.status) q = q.where('products.status', '=', input.status);
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql`(products.created_at, products.id)`, '<', sql`(${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('products.created_at', 'desc').orderBy('products.id', 'desc').limit(input.limit + 1).execute();
  const page = paginate(rows, input.limit, (r) => r.created_at);
  const stocks = await stocksFor(ctx, page.items.map((p) => p.id));
  const showCost = can(ctx.actor, 'product.manage');
  return { items: page.items.map((p) => ({ ...p, cost: showCost ? p.cost : null, price_inclusive: inclusivePrice(p), stocks: stocks.get(p.id) ?? [] })), nextCursor: page.nextCursor };
}

export async function getProduct(ctx: Ctx, id: string) {
  requireAnyPermission(ctx.actor, 'product.manage', 'pos.read', 'pos.operate');
  const p = await loadProduct(ctx, id);
  const [stocks, images] = await Promise.all([stocksFor(ctx, [id]), imageUrls(ctx, p.image_file_ids, 900)]);
  // cost (原価) is visible to product managers only (POS staff see sale prices)
  return { ...p, cost: can(ctx.actor, 'product.manage') ? p.cost : null, price_inclusive: inclusivePrice(p), stocks: stocks.get(id) ?? [], images };
}

export async function updateProduct(ctx: Ctx, id: string, input: UpdateProductInput) {
  requirePermission(ctx.actor, 'product.manage');
  const before = await loadProduct(ctx, id);
  assertShopAccess(ctx.actor, before.shop_id);
  await assertUnique(ctx, input, id);
  await assertFiles(ctx, input.imageFileIds);
  await ctx.trx
    .updateTable('products')
    .set({
      sku: input.sku,
      barcode: input.barcode,
      name: input.name,
      brand: input.brand,
      category: input.category,
      description: input.description,
      price: input.price,
      price_tax_included: input.priceTaxIncluded,
      cost: input.cost,
      tax_rate_bp: input.taxRateBp,
      image_file_ids: input.imageFileIds,
      is_online: input.isOnline,
      stock_managed: input.stockManaged,
      status: input.status,
      updated_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .where('id', '=', id)
    .execute();
  const after = await loadProduct(ctx, id);
  await audit(ctx, { action: 'product.update', resourceType: 'product', resourceId: id, shopId: after.shop_id, ...diff(before, after) });
  return getProduct(ctx, id);
}

export async function deleteProduct(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'product.manage');
  const before = await loadProduct(ctx, id);
  assertShopAccess(ctx.actor, before.shop_id);
  await ctx.trx.updateTable('products').set({ deleted_at: new Date(), status: 'inactive', is_online: false, updated_by: auditUserId(ctx.actor) }).where('id', '=', id).execute();
  await audit(ctx, { action: 'product.delete', resourceType: 'product', resourceId: id, shopId: before.shop_id, before });
}

// ---------------------------------------------------------------- stock

function assertLocation(product: { shop_id: string | null; name: string }, shopId: string | null) {
  if (product.shop_id && shopId && shopId !== product.shop_id) throw Errors.validation(`「${product.name}」はこの店舗の商品ではありません`);
}

export async function getStock(ctx: Ctx, productId: string) {
  requireAnyPermission(ctx.actor, 'product.manage', 'pos.read');
  const p = await loadProduct(ctx, productId);
  const stocks = (await stocksFor(ctx, [productId])).get(productId) ?? [];
  let mq = ctx.trx
    .selectFrom('stock_movements')
    .leftJoin('shops', 'shops.id', 'stock_movements.shop_id')
    .select(['stock_movements.id', 'stock_movements.shop_id', 'shops.name as shop_name', 'stock_movements.delta', 'stock_movements.reason', 'stock_movements.order_id', 'stock_movements.transaction_id', 'stock_movements.note', 'stock_movements.created_by', 'stock_movements.created_at'])
    .where('stock_movements.product_id', '=', productId);
  const shops = visibleProducts(ctx);
  if (shops) mq = mq.where((eb) => eb.or([eb('stock_movements.shop_id', 'is', null), eb('stock_movements.shop_id', 'in', shops)]));
  const movements = await mq.orderBy('stock_movements.created_at', 'desc').limit(50).execute();
  const names = await ctx.trx.selectFrom('shops').select(['id', 'name']).where('id', 'in', [NO_SHOP, ...stocks.map((s) => s.shop_id).filter((x): x is string => !!x)]).execute();
  const shopName = new Map(names.map((n) => [n.id, n.name]));
  return {
    productId,
    stockManaged: p.stock_managed,
    locations: stocks.map((s) => ({
      ...s,
      location: s.shop_id ? (shopName.get(s.shop_id) ?? '') : 'EC倉庫',
      low: s.reorder_point !== null && s.quantity <= s.reorder_point,
    })),
    total: stocks.reduce((a, s) => a + s.quantity, 0),
    movements,
  };
}

export async function adjustStock(ctx: Ctx, productId: string, input: StockAdjustmentInput) {
  requirePermission(ctx.actor, 'product.manage');
  const p = await loadProduct(ctx, productId);
  if (!p.stock_managed) throw Errors.business('STOCK_NOT_MANAGED', 'この商品は在庫管理対象外です');
  assertShopAccess(ctx.actor, input.shopId);
  assertLocation(p, input.shopId);
  const results: { shopId: string | null; quantity: number }[] = [];
  if (input.reason === 'transfer') {
    const to = input.toShopId ?? null;
    assertShopAccess(ctx.actor, to);
    assertLocation(p, to);
    const out = await applyStockMovement(ctx, { productId, shopId: input.shopId, delta: -input.delta, reason: 'transfer', note: input.note, productName: p.name });
    const inn = await applyStockMovement(ctx, { productId, shopId: to, delta: input.delta, reason: 'transfer', note: input.note, productName: p.name });
    results.push({ shopId: input.shopId, quantity: out.quantity }, { shopId: to, quantity: inn.quantity });
  } else {
    const r = await applyStockMovement(ctx, { productId, shopId: input.shopId, delta: input.delta, reason: input.reason, note: input.note, productName: p.name });
    results.push({ shopId: input.shopId, quantity: r.quantity });
  }
  await audit(ctx, { action: 'stock.adjust', resourceType: 'product', resourceId: productId, shopId: input.shopId, after: { ...input, results } });
  return getStock(ctx, productId);
}

export async function setStockSettings(ctx: Ctx, productId: string, input: { shopId: string | null; reorderPoint: number | null }) {
  requirePermission(ctx.actor, 'product.manage');
  const p = await loadProduct(ctx, productId);
  assertShopAccess(ctx.actor, input.shopId);
  assertLocation(p, input.shopId);
  await sql`
    INSERT INTO product_stocks (organization_id, product_id, shop_id, quantity, reorder_point)
    VALUES (${ctx.actor.organizationId}, ${productId}, ${input.shopId}, 0, ${input.reorderPoint})
    ON CONFLICT (product_id, coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET reorder_point = EXCLUDED.reorder_point`.execute(ctx.trx);
  await audit(ctx, { action: 'stock.settings', resourceType: 'product', resourceId: productId, shopId: input.shopId, after: input });
  return getStock(ctx, productId);
}

export async function lowStock(ctx: Ctx, input: { shopId?: string }) {
  requireAnyPermission(ctx.actor, 'product.manage', 'pos.read');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  let q = ctx.trx
    .selectFrom('product_stocks as s')
    .innerJoin('products', 'products.id', 's.product_id')
    .leftJoin('shops', 'shops.id', 's.shop_id')
    .select(['products.id as product_id', 'products.name', 'products.sku', 'products.barcode', 's.shop_id', 'shops.name as shop_name', 's.quantity', 's.reorder_point'])
    .where('products.deleted_at', 'is', null)
    .where('products.status', '=', 'active')
    .where('products.stock_managed', '=', true)
    .where('s.reorder_point', 'is not', null)
    .whereRef('s.quantity', '<=', 's.reorder_point');
  const shops = visibleProducts(ctx);
  if (shops) q = q.where((eb) => eb.or([eb('s.shop_id', 'is', null), eb('s.shop_id', 'in', shops)]));
  if (input.shopId) q = q.where('s.shop_id', '=', input.shopId);
  const rows = await q.orderBy(sql`s.quantity - s.reorder_point`).orderBy('products.name').limit(500).execute();
  return rows.map((r) => ({ ...r, location: r.shop_id ? r.shop_name : 'EC倉庫', shortage: (r.reorder_point ?? 0) - r.quantity }));
}

// ---------------------------------------------------------------- product URL share (顧客への商品URL共有)

export async function shareProduct(ctx: Ctx, productId: string, input: { customerId: string; message?: string }) {
  requirePermission(ctx.actor, 'message.send');
  const p = await loadProduct(ctx, productId);
  await assertCustomerAccess(ctx, input.customerId);
  if (p.status !== 'active' || !p.is_online) throw Errors.business('PRODUCT_NOT_ONLINE', 'オンライン販売中の商品のみ共有できます');
  const staffId = ctx.actor.kind === 'staff' ? ctx.actor.staffId : null;
  const shopId = p.shop_id ?? ctx.meta.currentShopId ?? (ctx.actor.kind === 'staff' ? (ctx.actor.shopIds[0] ?? null) : null);
  // staff attribution: the order placed through this link credits the sharing stylist (店販紹介)
  const link = await ensureReferralLink(ctx, {
    name: `商品共有: ${p.name}`,
    shopId,
    staffId,
    target: 'product',
    targetId: p.id,
    utm: { source: 'salon', medium: 'product_share' },
  });
  const url = referralUrl(link.code);
  const staff = staffId ? await ctx.trx.selectFrom('staffs').select('display_name').where('id', '=', staffId).executeTakeFirst() : null;
  // 1:1 message initiated by the stylist for this customer → 'conversation'
  const res = await queueMessage(ctx, {
    customerId: input.customerId,
    shopId,
    category: 'conversation',
    templateKey: 'product_share',
    vars: { product: { name: p.name, price: inclusivePrice(p), url }, staff: { name: staff?.display_name ?? '' }, message: input.message ?? '' },
    sentByStaffId: staffId,
  });
  await audit(ctx, { action: 'product.share', resourceType: 'product', resourceId: p.id, shopId, metadata: { customerId: input.customerId, referralLinkId: link.id, messageId: res.messageId } });
  return { url, referralLinkId: link.id, referralCode: link.code, messageId: res.messageId };
}

// ---------------------------------------------------------------- public storefront

function stockStatus(stockManaged: boolean, quantity: number | null): { inStock: boolean; stockStatus: 'in_stock' | 'low' | 'out_of_stock' } {
  if (!stockManaged) return { inStock: true, stockStatus: 'in_stock' };
  const q = quantity ?? 0;
  return { inStock: q > 0, stockStatus: q <= 0 ? 'out_of_stock' : q <= 3 ? 'low' : 'in_stock' };
}

function publicBase(ctx: Ctx) {
  return ctx.trx
    .selectFrom('products')
    .leftJoin('product_stocks as s', (j) => j.onRef('s.product_id', '=', 'products.id').on('s.shop_id', 'is', null))
    .select(['products.id', 'products.name', 'products.brand', 'products.category', 'products.description', 'products.price', 'products.price_tax_included', 'products.tax_rate_bp', 'products.image_file_ids', 'products.stock_managed', 'products.created_at', 's.quantity as ec_quantity'])
    .where('products.deleted_at', 'is', null)
    .where('products.status', '=', 'active')
    .where('products.is_online', '=', true);
}

type PublicRow = Awaited<ReturnType<ReturnType<typeof publicBase>['execute']>>[number];

async function publicProductView(ctx: Ctx, p: PublicRow) {
  return {
    id: p.id,
    name: p.name,
    brand: p.brand,
    category: p.category,
    description: p.description,
    price: inclusivePrice(p),
    taxRateBp: p.tax_rate_bp,
    images: (await imageUrls(ctx, p.image_file_ids)).map((i) => i.url),
    ...stockStatus(p.stock_managed, p.ec_quantity),
  };
}

export async function publicShopProducts(ctx: Ctx, shopId: string, input: { category?: string; cursor?: string; limit: number }) {
  let q = publicBase(ctx).where((eb) => eb.or([eb('products.shop_id', 'is', null), eb('products.shop_id', '=', shopId)]));
  if (input.category) q = q.where('products.category', '=', input.category);
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql`(products.created_at, products.id)`, '<', sql`(${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('products.created_at', 'desc').orderBy('products.id', 'desc').limit(input.limit + 1).execute();
  const page = paginate(rows, input.limit, (r) => r.created_at);
  const items = [];
  for (const p of page.items) items.push(await publicProductView(ctx, p));
  return { items, nextCursor: page.nextCursor };
}

/** Public product page (GET /public/products/:id): tenant is resolved from the product id */
export async function publicProduct(productId: string, meta: RequestMeta) {
  const found = await withSystem((trx) =>
    trx
      .selectFrom('products')
      .innerJoin('organizations', 'organizations.id', 'products.organization_id')
      .leftJoin('shops', 'shops.id', 'products.shop_id')
      .select(['products.organization_id', 'organizations.status as org_status', 'organizations.name as org_name', 'shops.slug as shop_slug', 'shops.name as shop_name'])
      .where('products.id', '=', productId)
      .where('products.deleted_at', 'is', null)
      .where('products.is_online', '=', true)
      .where('products.status', '=', 'active')
      .executeTakeFirst(),
  );
  if (!found || !['active', 'trial'].includes(found.org_status)) throw Errors.notFound('商品', productId);
  const orgId = found.organization_id;
  return withTenant(
    orgId,
    async (trx) => {
      const ctx: Ctx = { actor: systemActor(orgId, 'public'), trx, meta };
      const row = await publicBase(ctx).where('products.id', '=', productId).executeTakeFirst();
      if (!row) throw Errors.notFound('商品', productId);
      return {
        ...(await publicProductView(ctx, row)),
        seller: { name: found.shop_name ?? found.org_name, shopSlug: found.shop_slug },
        url: found.shop_slug ? `${config.WEB_BASE_URL.replace(/\/$/, '')}/shop/${found.shop_slug}/products/${productId}` : null,
      };
    },
    { traceId: meta.traceId },
  );
}
