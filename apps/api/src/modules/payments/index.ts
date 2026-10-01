import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { idParam } from '../../lib/schemas.js';
import { registerWebhookProvider } from '../../lib/webhooks.js';
import { createCustomMethodSchema, listCustomMethodsSchema, mockCompleteSchema, refundSchema, startPaymentSchema, updateCustomMethodSchema } from './schemas.js';
import * as svc from './service.js';
import { stripeWebhookProvider } from './webhook.js';

// Stripe webhooks: the generic route POST /v1/webhooks/stripe (integrations module) verifies via this provider
registerWebhookProvider('stripe', stripeWebhookProvider);

const tags = ['payments'];

const headerKey = (h: Record<string, unknown>) => (typeof h['idempotency-key'] === 'string' ? (h['idempotency-key'] as string) : undefined);

const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/payments',
    {
      config: { idempotent: true },
      schema: { tags, summary: 'オンライン決済開始(会計/注文)', description: 'idempotencyKey(本文)またはIdempotency-Keyヘッダー必須。金額省略時は未払い残高。二重課金防止。', body: startPaymentSchema },
    },
    async (req, reply) => reply.status(201).send(await req.tx((ctx) => svc.startPayment(ctx, req.body, headerKey(req.headers)))),
  );
  app.get('/payments/:id', { schema: { tags, summary: '決済詳細(返金履歴含む)', params: idParam } }, (req) => req.tx((ctx) => svc.getPayment(ctx, req.params.id)));
  app.post(
    '/payments/:id/refund',
    { config: { idempotent: true }, schema: { tags, summary: '返金(全額/一部)', description: 'pos.refund 権限。idempotencyKey必須。', params: idParam, body: refundSchema } },
    (req) => req.tx((ctx) => svc.refundPaymentRequest(ctx, req.params.id, req.body, headerKey(req.headers))),
  );
  app.post(
    '/payments/:id/mock-complete',
    { schema: { tags, summary: '[dev/test] モック決済の完了/失敗をシミュレート', description: 'PAYMENT_PROVIDER=mock の場合のみ有効', params: idParam, body: mockCompleteSchema.optional() } },
    (req) => req.tx((ctx) => svc.mockComplete(ctx, req.params.id, req.body ?? { success: true })),
  );

  // 店舗独自決済
  app.get('/payment-methods/custom', { schema: { tags, summary: '店舗独自決済一覧', querystring: listCustomMethodsSchema } }, (req) => req.tx((ctx) => svc.listCustomMethods(ctx, req.query)));
  app.post('/payment-methods/custom', { schema: { tags, summary: '店舗独自決済の作成', body: createCustomMethodSchema } }, async (req, reply) =>
    reply.status(201).send(await req.tx((ctx) => svc.createCustomMethod(ctx, req.body))),
  );
  app.patch('/payment-methods/custom/:id', { schema: { tags, summary: '店舗独自決済の更新', params: idParam, body: updateCustomMethodSchema } }, (req) =>
    req.tx((ctx) => svc.updateCustomMethod(ctx, req.params.id, req.body)),
  );
  app.delete('/payment-methods/custom/:id', { schema: { tags, summary: '店舗独自決済の削除(使用済みは無効化)', params: idParam } }, (req) =>
    req.tx((ctx) => svc.deleteCustomMethod(ctx, req.params.id)),
  );
};

export default plugin;
