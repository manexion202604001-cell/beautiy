import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { storage } from '../../lib/storage.js';
import { api, asSystem, createCustomer, createStaffUser, createTenant, shopSlug } from '../../test/helpers.js';
import { decrementStockForSale, restockForReturn } from './api.js';

describe('products', () => {
  it('supports CRUD with org-unique SKU/barcode and permission checks', async () => {
    const t = await createTenant();
    const created = await t.owner.post('/v1/products', { name: 'オーガニックシャンプー', sku: 'SH-001', barcode: '4900000000011', brand: 'Salon', category: 'ヘアケア', price: 3300, cost: 1200 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'オーガニックシャンプー', shop_id: null, price_inclusive: 3300, is_online: false, stock_managed: true, status: 'active' });

    const dupSku = await t.owner.post('/v1/products', { name: '別商品', sku: 'SH-001', price: 100 });
    expect(dupSku.status).toBe(409);
    expect(dupSku.body.error.code).toBe('SKU_DUPLICATE');
    const dupBarcode = await t.owner.post('/v1/products', { name: '別商品', barcode: '4900000000011', price: 100 });
    expect(dupBarcode.body.error.code).toBe('BARCODE_DUPLICATE');
    // another organization may reuse the same SKU
    const other = await createTenant('他社');
    expect((await other.owner.post('/v1/products', { name: '他社商品', sku: 'SH-001', price: 100 })).status).toBe(201);
    expect((await other.owner.get(`/v1/products/${created.body.id}`)).status).toBe(404);

    const exclusive = await t.owner.post('/v1/products', { name: '税抜価格の商品', price: 1000, priceTaxIncluded: false, taxRateBp: 800 });
    expect(exclusive.body.price_inclusive).toBe(1080);

    const patched = await t.owner.patch(`/v1/products/${created.body.id}`, { price: 3520, isOnline: true });
    expect(patched.body).toMatchObject({ price: 3520, is_online: true, sku: 'SH-001' });
    const audits = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('audit_logs').selectAll().where('resource_id', '=', created.body.id).where('action', '=', 'product.update').execute());
    expect(audits[0]!.before).toMatchObject({ price: 3300, is_online: false });

    const search = await t.owner.get('/v1/products', { q: 'シャンプー' });
    expect(search.body.items.map((p: { id: string }) => p.id)).toEqual([created.body.id]);
    expect((await t.owner.get('/v1/products', { barcode: '4900000000011' })).body.items).toHaveLength(1);

    const stylist = await createStaffUser(t, 'stylist');
    const posView = await stylist.api.get('/v1/products', { q: 'シャンプー' });
    expect(posView.status).toBe(200); // pos.read
    expect(posView.body.items[0].cost).toBeNull();
    expect((await t.owner.get(`/v1/products/${created.body.id}`)).body.cost).toBe(1200);
    expect((await stylist.api.post('/v1/products', { name: 'x', price: 1 })).status).toBe(403);
    expect((await stylist.api.patch(`/v1/products/${created.body.id}`, { price: 1 })).status).toBe(403);

    expect((await t.owner.delete(`/v1/products/${exclusive.body.id}`)).status).toBe(204);
    expect((await t.owner.get(`/v1/products/${exclusive.body.id}`)).status).toBe(404);
    // SKU of a deleted product becomes reusable
    expect((await t.owner.post('/v1/products', { name: '再登録', sku: 'SH-001-B', price: 1 })).status).toBe(201);
  });

  it('limits shop-level products to staff of that shop', async () => {
    const t = await createTenant();
    const shop2 = await t.owner.post('/v1/shops', { name: '2号店', slug: `shop2-${randomUUID().slice(0, 8)}` });
    expect(shop2.status).toBe(201);
    const shop2Id = shop2.body.id ?? shop2.body.shop?.id;
    const p2 = await t.owner.post('/v1/products', { name: '2号店限定', price: 500, shopId: shop2Id });
    const common = await t.owner.post('/v1/products', { name: '共通', price: 500 });
    const manager = await createStaffUser(t, 'manager', { shopIds: [t.shopId] });
    const list = await manager.api.get('/v1/products');
    expect(list.body.items.map((p: { id: string }) => p.id)).toEqual([common.body.id]);
    expect((await manager.api.get(`/v1/products/${p2.body.id}`)).status).toBe(404);
    expect((await manager.api.post('/v1/products', { name: 'x', price: 1, shopId: shop2Id })).status).toBe(403);
    // shop-level product cannot be stocked at another shop
    const bad = await t.owner.post(`/v1/products/${p2.body.id}/stock-adjustments`, { shopId: t.shopId, delta: 1, reason: 'receive' });
    expect(bad.status).toBe(400);
  });
});

describe('stock', () => {
  it('adjusts, transfers and reports low stock with movements and audit', async () => {
    const t = await createTenant();
    const p = (await t.owner.post('/v1/products', { name: 'トリートメント', price: 4400, isOnline: true })).body;
    const receive = await t.owner.post(`/v1/products/${p.id}/stock-adjustments`, { shopId: t.shopId, delta: 10, reason: 'receive', note: '初回入荷' });
    expect(receive.status).toBe(201);
    expect(receive.body.locations).toEqual([expect.objectContaining({ shop_id: t.shopId, quantity: 10 })]);

    expect((await t.owner.post(`/v1/products/${p.id}/stock-adjustments`, { shopId: t.shopId, delta: -3, reason: 'adjust', note: '棚卸差異' })).status).toBe(201);
    const short = await t.owner.post(`/v1/products/${p.id}/stock-adjustments`, { shopId: t.shopId, delta: -100, reason: 'adjust' });
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(short.body.error.details.available).toBe(7);
    expect((await t.owner.post(`/v1/products/${p.id}/stock-adjustments`, { shopId: t.shopId, delta: -1, reason: 'receive' })).status).toBe(400);
    expect((await t.owner.post(`/v1/products/${p.id}/stock-adjustments`, { shopId: t.shopId, delta: 1, reason: 'transfer' })).status).toBe(400);

    const transfer = await t.owner.post(`/v1/products/${p.id}/stock-adjustments`, { shopId: t.shopId, delta: 5, reason: 'transfer', toShopId: null });
    expect(transfer.status).toBe(201);
    const stock = (await t.owner.get(`/v1/products/${p.id}/stock`)).body;
    expect(stock.locations).toEqual([
      expect.objectContaining({ shop_id: null, quantity: 5, location: 'EC倉庫' }),
      expect.objectContaining({ shop_id: t.shopId, quantity: 2 }),
    ]);
    expect(stock.total).toBe(7);
    expect(stock.movements.map((m: { reason: string; delta: number }) => `${m.reason}:${m.delta}`).sort()).toEqual(['adjust:-3', 'receive:10', 'transfer:-5', 'transfer:5'].sort());

    await t.owner.put(`/v1/products/${p.id}/stock-settings`, { shopId: t.shopId, reorderPoint: 3 });
    const low = await t.owner.get('/v1/products/low-stock');
    expect(low.body).toEqual([expect.objectContaining({ product_id: p.id, shop_id: t.shopId, quantity: 2, reorder_point: 3, shortage: 1 })]);

    const audits = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('audit_logs').select('action').where('resource_id', '=', p.id).where('action', '=', 'stock.adjust').execute());
    expect(audits).toHaveLength(3);

    // POS contract: sale may go negative (goods physically sold), return restocks
    const sale = await asSystem(t.organizationId, (ctx) => decrementStockForSale(ctx, { productId: p.id, shopId: t.shopId, quantity: 3, transactionId: randomUUID() }));
    expect(sale).toEqual({ tracked: true, quantity: -1, belowReorderPoint: true });
    const ret = await asSystem(t.organizationId, (ctx) => restockForReturn(ctx, { productId: p.id, shopId: t.shopId, quantity: 1, transactionId: randomUUID() }));
    expect(ret.quantity).toBe(0);

    const service = (await t.owner.post('/v1/products', { name: 'ギフト券', price: 5000, stockManaged: false })).body;
    expect((await t.owner.post(`/v1/products/${service.id}/stock-adjustments`, { shopId: t.shopId, delta: 1, reason: 'receive' })).body.error.code).toBe('STOCK_NOT_MANAGED');
    expect(await asSystem(t.organizationId, (ctx) => decrementStockForSale(ctx, { productId: service.id, shopId: t.shopId, quantity: 1, transactionId: randomUUID() }))).toMatchObject({ tracked: false });
  });
});

describe('storefront & product sharing', () => {
  it('lists online products publicly with prices, images and stock status', async () => {
    const t = await createTenant();
    const slug = await shopSlug(t);
    const key = `${t.organizationId}/products/${randomUUID()}.png`;
    await storage.put(key, Buffer.from('png'), 'image/png');
    const fileId = await asSystem(t.organizationId, async (ctx) =>
      (await ctx.trx.insertInto('files').values({ organization_id: t.organizationId, object_key: key, purpose: 'product_image', content_type: 'image/png', status: 'uploaded' }).returning('id').executeTakeFirstOrThrow()).id,
    );
    const online = (await t.owner.post('/v1/products', { name: 'ヘアオイル', price: 2000, priceTaxIncluded: false, isOnline: true, imageFileIds: [fileId], cost: 500 })).body;
    const soldOut = (await t.owner.post('/v1/products', { name: '完売品', price: 1000, isOnline: true })).body;
    const offline = (await t.owner.post('/v1/products', { name: '店頭のみ', price: 1000 })).body;
    await t.owner.post(`/v1/products/${online.id}/stock-adjustments`, { shopId: null, delta: 20, reason: 'receive' });
    expect((await t.owner.post('/v1/products', { name: 'x', price: 1, imageFileIds: [randomUUID()] })).status).toBe(400);

    const res = await api().get(`/v1/public/shops/${slug}/products`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((p: { id: string }) => p.id);
    expect(ids).toContain(online.id);
    expect(ids).toContain(soldOut.id);
    expect(ids).not.toContain(offline.id);
    const oil = res.body.items.find((p: { id: string }) => p.id === online.id);
    expect(oil).toMatchObject({ price: 2200, inStock: true, stockStatus: 'in_stock' });
    expect(oil.images[0]).toContain('/v1/files/blob/');
    expect(oil.cost).toBeUndefined();
    expect(res.body.items.find((p: { id: string }) => p.id === soldOut.id)).toMatchObject({ inStock: false, stockStatus: 'out_of_stock' });

    const detail = await api().get(`/v1/public/products/${online.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: online.id, price: 2200, seller: { name: expect.any(String) } });
    expect((await api().get(`/v1/public/products/${offline.id}`)).status).toBe(404);
    expect((await api().get(`/v1/public/products/${randomUUID()}`)).status).toBe(404);
  });

  it('shares a product URL with a customer and attributes it to the sharing stylist', async () => {
    const t = await createTenant();
    const slug = await shopSlug(t);
    const stylist = await createStaffUser(t, 'stylist', { displayName: '店販スタイリスト' });
    const customer = await createCustomer(t);
    const p = (await t.owner.post('/v1/products', { name: 'カラーシャンプー', price: 3080, isOnline: true })).body;
    const shared = await stylist.api.post(`/v1/products/${p.id}/share`, { customerId: customer.id, message: '色持ちが良くなります' });
    expect(shared.status).toBe(200);
    expect(shared.body.url).toContain(`/v1/public/r/${shared.body.referralCode}`);
    const again = await stylist.api.post(`/v1/products/${p.id}/share`, { customerId: customer.id });
    expect(again.body.referralCode).toBe(shared.body.referralCode);

    const msg = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('messages').selectAll().where('id', '=', shared.body.messageId).executeTakeFirstOrThrow());
    expect(msg).toMatchObject({ customer_id: customer.id, category: 'conversation', sent_by_staff_id: stylist.staffId });
    expect(msg.payload).toMatchObject({ templateKey: 'product_share', vars: { product: { name: 'カラーシャンプー', price: 3080, url: shared.body.url }, staff: { name: '店販スタイリスト' } } });

    const link = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('referral_links').selectAll().where('id', '=', shared.body.referralLinkId).executeTakeFirstOrThrow());
    expect(link).toMatchObject({ staff_id: stylist.staffId, target: 'product', target_id: p.id });
    const r = await api().get(`/v1/public/r/${shared.body.referralCode}`);
    expect(r.status).toBe(302);
    expect(new URL(r.headers.location as string).pathname).toBe(`/shop/${slug}/products/${p.id}`);

    const offline = (await t.owner.post('/v1/products', { name: '店頭のみ', price: 1000 })).body;
    expect((await stylist.api.post(`/v1/products/${offline.id}/share`, { customerId: customer.id })).body.error.code).toBe('PRODUCT_NOT_ONLINE');
    const assistant = await createStaffUser(t, 'assistant');
    expect((await assistant.api.post(`/v1/products/${p.id}/share`, { customerId: customer.id })).status).toBe(403);
  });
});
