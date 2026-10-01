import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { registerJob } from '../../jobs/queue.js';
import { Errors } from '../../lib/errors.js';
import { onEvent } from '../../lib/events.js';
import { registerOrgSeeder } from '../../lib/org-seeders.js';
import { idParam, uuid } from '../../lib/schemas.js';
import { publicTx, resolveShopSlug } from '../public/service.js';
import * as orders from './orders.js';
import * as products from './products.js';
import { commerceSales } from './sales.js';
import {
  cancelOrderSchema,
  createOrderSchema,
  createProductSchema,
  listOrdersSchema,
  listProductsSchema,
  lowStockSchema,
  publicProductsSchema,
  salesQuerySchema,
  shareProductSchema,
  shipOrderSchema,
  stockAdjustmentSchema,
  stockSettingsSchema,
  updateProductSchema,
} from './schemas.js';

// ---------------------------------------------------------------- side effects

type PaymentEvent = { paymentId: string; transactionId: string | null; orderId: string | null; amount: number; refundedAmount?: number };
onEvent<PaymentEvent>('payment.succeeded', (ctx, e) => orders.onPaymentSucceeded(ctx, e.payload));
onEvent<PaymentEvent>('payment.failed', (ctx, e) => orders.onPaymentFailed(ctx, e.payload));
onEvent<PaymentEvent>('payment.refunded', (ctx, e) => orders.onPaymentRefunded(ctx, e.payload));

registerJob<{ orderId: string }>('commerce.expire_order', async (p, jc) => {
  await jc.tx((ctx) => orders.expireOrder(ctx, p.orderId));
});
registerJob<{ paymentId: string; orderId: string; amount: number }>('commerce.refund_orphan_payment', async (p, jc) => {
  await jc.tx((ctx) => orders.refundOrphanPayment(ctx, p));
});

// Default message templates (late, never overwrites templates seeded by the messaging module)
const TEMPLATES: { key: string; name: string; category: 'transactional' | 'marketing'; subject: string; body: string }[] = [
  {
    key: 'product_share',
    name: '商品のご紹介',
    category: 'marketing',
    subject: '【{{shop.name}}】{{staff.name}}よりおすすめ商品のご案内',
    body: '{{customer.name}}様\n{{staff.name}}よりおすすめの商品をご案内いたします。\n{{message}}\n\n{{product.name}}（税込{{product.price}}円）\n{{product.url}}',
  },
  {
    key: 'order_paid',
    name: 'ご注文確認',
    category: 'transactional',
    subject: '【{{shop.name}}】ご注文ありがとうございます（{{order.number}}）',
    body: '{{customer.name}}様\nご注文ありがとうございます。お支払いを確認いたしました。\n注文番号: {{order.number}}\nお支払い金額: {{order.total}}円（税込）\n発送までしばらくお待ちください。',
  },
  {
    key: 'order_shipped',
    name: '発送のお知らせ',
    category: 'transactional',
    subject: '【{{shop.name}}】商品を発送しました（{{order.number}}）',
    body: '{{customer.name}}様\nご注文の商品を発送いたしました。\n注文番号: {{order.number}}\n配送業者: {{shipping.carrier}}\n伝票番号: {{shipping.trackingNumber}}',
  },
  {
    key: 'order_cancelled',
    name: 'ご注文キャンセルのお知らせ',
    category: 'transactional',
    subject: '【{{shop.name}}】ご注文キャンセルのお知らせ（{{order.number}}）',
    body: '{{customer.name}}様\nご注文（注文番号: {{order.number}}）はキャンセルとなりました。\n理由: {{order.cancelReason}}\n返金額: {{order.refundedAmount}}円',
  },
];

registerOrgSeeder(
  'commerce.templates',
  async (ctx) => {
    await ctx.trx
      .insertInto('message_templates')
      .values(
        TEMPLATES.flatMap((t) =>
          (['line', 'email'] as const).map((channel) => ({
            organization_id: ctx.actor.organizationId,
            key: t.key,
            name: t.name,
            channel,
            category: t.category,
            subject: channel === 'email' ? t.subject : null,
            body: t.body,
          })),
        ),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  },
  900,
);

// ---------------------------------------------------------------- routes

const tags = ['commerce'];
const customer = { auth: 'customer' as const };

const plugin: FastifyPluginAsyncZod = async (app) => {
  // ----- products (商品マスタ)
  app.get('/products', { schema: { tags, summary: '商品一覧', querystring: listProductsSchema } }, (req) => req.tx((ctx) => products.listProducts(ctx, req.query)));
  app.post('/products', { config: { idempotent: true }, schema: { tags, summary: '商品登録(店舗/法人共通)', body: createProductSchema } }, async (req, reply) =>
    reply.status(201).send(await req.tx((ctx) => products.createProduct(ctx, req.body))),
  );
  app.get('/products/low-stock', { schema: { tags, summary: '在庫僅少一覧(発注点以下)', querystring: lowStockSchema } }, (req) => req.tx((ctx) => products.lowStock(ctx, req.query)));
  app.get('/products/:id', { schema: { tags, params: idParam } }, (req) => req.tx((ctx) => products.getProduct(ctx, req.params.id)));
  app.patch('/products/:id', { schema: { tags, params: idParam, body: updateProductSchema } }, (req) => req.tx((ctx) => products.updateProduct(ctx, req.params.id, req.body)));
  app.delete('/products/:id', { schema: { tags, params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => products.deleteProduct(ctx, req.params.id));
    return reply.status(204).send();
  });
  app.get('/products/:id/stock', { schema: { tags, summary: '在庫(店舗別・EC倉庫)と入出庫履歴', params: idParam } }, (req) => req.tx((ctx) => products.getStock(ctx, req.params.id)));
  app.post(
    '/products/:id/stock-adjustments',
    { config: { idempotent: true }, schema: { tags, summary: '在庫調整(入荷/調整/移動/返品)', params: idParam, body: stockAdjustmentSchema } },
    async (req, reply) => reply.status(201).send(await req.tx((ctx) => products.adjustStock(ctx, req.params.id, req.body))),
  );
  app.put('/products/:id/stock-settings', { schema: { tags, summary: '発注点の設定', params: idParam, body: stockSettingsSchema } }, (req) =>
    req.tx((ctx) => products.setStockSettings(ctx, req.params.id, req.body)),
  );
  app.post('/products/:id/share', { config: { idempotent: true }, schema: { tags, summary: '顧客へ商品URLを共有(スタッフ紹介計測付き)', params: idParam, body: shareProductSchema } }, (req) =>
    req.tx((ctx) => products.shareProduct(ctx, req.params.id, req.body)),
  );

  // ----- orders (staff)
  app.get('/orders', { schema: { tags, summary: 'EC注文一覧', querystring: listOrdersSchema } }, (req) => req.tx((ctx) => orders.listOrders(ctx, req.query)));
  app.get('/orders/:id', { schema: { tags, params: idParam } }, (req) => req.tx((ctx) => orders.getOrder(ctx, req.params.id)));
  app.post('/orders/:id/process', { config: { idempotent: true }, schema: { tags, summary: '出荷準備中にする', params: idParam } }, (req) => req.tx((ctx) => orders.processOrder(ctx, req.params.id)));
  app.post('/orders/:id/ship', { config: { idempotent: true }, schema: { tags, summary: '発送(発送通知を送信)', params: idParam, body: shipOrderSchema } }, (req) =>
    req.tx((ctx) => orders.shipOrder(ctx, req.params.id, req.body)),
  );
  app.post('/orders/:id/deliver', { config: { idempotent: true }, schema: { tags, summary: '配達完了', params: idParam } }, (req) => req.tx((ctx) => orders.deliverOrder(ctx, req.params.id)));
  app.post('/orders/:id/cancel', { config: { idempotent: true }, schema: { tags, summary: 'キャンセル(支払済は返金・在庫戻し)', params: idParam, body: cancelOrderSchema } }, (req) =>
    req.tx((ctx) => orders.cancelOrder(ctx, req.params.id, req.body.reason)),
  );

  // ----- sales (商品別/スタッフ別売上)
  app.get('/commerce/sales', { schema: { tags, summary: '商品別/スタッフ別売上(EC+店販)', querystring: salesQuerySchema } }, (req) => req.tx((ctx) => commerceSales(ctx, req.query)));

  // ----- public storefront (LINE/Web)
  app.get(
    '/public/shops/:slug/products',
    { config: { auth: 'public', rateLimit: { max: 120, timeWindow: '1 minute' } }, schema: { tags, summary: 'EC商品一覧', params: z.object({ slug: z.string().min(1).max(60) }), querystring: publicProductsSchema } },
    async (req) => {
      const shop = await resolveShopSlug(req.params.slug);
      return publicTx(shop, req.meta, (ctx) => products.publicShopProducts(ctx, shop.shopId, req.query));
    },
  );
  app.get('/public/products/:id', { config: { auth: 'public', rateLimit: { max: 120, timeWindow: '1 minute' } }, schema: { tags, summary: 'EC商品詳細', params: idParam } }, (req) =>
    products.publicProduct(req.params.id, req.meta),
  );

  // ----- orders (customer)
  app.post('/public/orders', { config: { ...customer, rateLimit: { max: 20, timeWindow: '1 minute' } }, schema: { tags, summary: 'EC注文(在庫引当+オンライン決済開始)', body: createOrderSchema } }, async (req, reply) => {
    const shop = await resolveShopSlug(req.body.shopSlug);
    const actor = req.customer();
    if (actor.organizationId !== shop.organizationId) throw Errors.notFound('店舗');
    const result = await req.tx((ctx) => orders.createOrder(ctx, shop, req.body));
    return reply.status(result.replayed ? 200 : 201).send(result);
  });
  app.get('/public/me/orders', { config: customer, schema: { tags, summary: '自分の注文一覧' } }, (req) => req.tx((ctx) => orders.listMyOrders(ctx, req.customer().customerId)));
  app.get('/public/me/orders/:id', { config: customer, schema: { tags, params: idParam } }, (req) => req.tx((ctx) => orders.getMyOrder(ctx, req.customer().customerId, req.params.id)));
  app.post('/public/me/orders/:id/pay', { config: customer, schema: { tags, summary: '決済の再試行(支払失敗時)', params: z.object({ id: uuid }) } }, (req) =>
    req.tx((ctx) => orders.retryOrderPayment(ctx, req.customer().customerId, req.params.id)),
  );
};

export default plugin;
