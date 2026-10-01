import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { idParam, uuid } from '../../lib/schemas.js';
import * as accounts from './accounts.js';
import './adapters/mock-booking.js';
import * as conflicts from './conflicts.js';
import './push.js';
import { createIntegrationSchema, listConflictsSchema, resolveConflictSchema, resyncSchema, syncJobsQuery, updateIntegrationSchema } from './schemas.js';
import './sync.js';
import { receiveWebhook, WEBHOOK_BODY_LIMIT } from './webhooks.js';

const tags = ['integrations'];

/**
 * Integration Hub (FR-06): external booking media accounts, sync engine (delta/full), slot pushes,
 * conflict resolution queue, per-shop sync status, and the generic inbound webhook endpoint.
 */
const plugin: FastifyPluginAsyncZod = async (app) => {
  // ---- accounts
  app.get('/integrations', { schema: { tags, summary: '外部連携一覧' } }, (req) => req.tx((ctx) => accounts.listIntegrations(ctx)));
  app.get('/integrations/status', { schema: { tags, summary: '店舗向け同期ステータス(最終成功・エラー・縮退・未解決競合)', querystring: z.object({ shopId: uuid.optional() }) } }, (req) =>
    req.tx((ctx) => conflicts.syncStatus(ctx, req.query.shopId)),
  );
  app.post(
    '/integrations',
    { config: { idempotent: true }, schema: { tags, summary: '外部連携の登録(認証情報は暗号化保存・返却しない)', body: createIntegrationSchema } },
    async (req, reply) => reply.status(201).send(await req.tx((ctx) => accounts.createIntegration(ctx, req.body))),
  );
  app.get('/integrations/:id', { schema: { tags, params: idParam } }, (req) => req.tx((ctx) => accounts.getIntegration(ctx, req.params.id)));
  app.patch('/integrations/:id', { schema: { tags, summary: '外部連携の更新(対応表・競合ルール・枠反映)', params: idParam, body: updateIntegrationSchema } }, (req) =>
    req.tx((ctx) => accounts.updateIntegration(ctx, req.params.id, req.body)),
  );
  app.delete('/integrations/:id', { schema: { tags, summary: '外部連携の無効化', params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => accounts.disableIntegration(ctx, req.params.id));
    return reply.status(204).send();
  });
  app.post('/integrations/:id/test', { schema: { tags, summary: '接続テスト(ヘルスチェック)', params: idParam } }, (req) => req.tx((ctx) => accounts.testIntegration(ctx, req.params.id)));
  app.post('/integrations/:id/resync', { schema: { tags, summary: '再同期(差分/全件)', params: idParam, body: resyncSchema.prefault({}) } }, async (req, reply) =>
    reply.status(202).send(await req.tx((ctx) => conflicts.requestResync(ctx, req.params.id, req.body.mode))),
  );
  app.get('/integrations/:id/sync-jobs', { schema: { tags, summary: '同期ジョブ履歴', params: idParam, querystring: syncJobsQuery } }, (req) =>
    req.tx((ctx) => conflicts.listSyncJobs(ctx, req.params.id, req.query)),
  );

  // ---- conflict queue
  app.get('/sync-conflicts', { schema: { tags, summary: '同期競合キュー', querystring: listConflictsSchema } }, (req) => req.tx((ctx) => conflicts.listConflicts(ctx, req.query)));
  app.get('/sync-conflicts/:id', { schema: { tags, params: idParam } }, (req) => req.tx((ctx) => conflicts.getConflict(ctx, req.params.id)));
  app.post(
    '/sync-conflicts/:id/resolve',
    { config: { idempotent: true }, schema: { tags, summary: '競合の解決(keep_internal / accept_external / ignore / manual)', params: idParam, body: resolveConflictSchema } },
    (req) => req.tx((ctx) => conflicts.resolveConflict(ctx, req.params.id, req.body)),
  );

  // ---- inbound webhooks (public; authenticated by provider signature)
  const webhookParams = z.object({ provider: z.string().min(1).max(50).regex(/^[a-z0-9_-]+$/), key: z.string().min(1).max(200).optional() });
  const webhookOpts = {
    config: { auth: 'public' as const, rateLimit: { max: 600, timeWindow: '1 minute' } },
    bodyLimit: WEBHOOK_BODY_LIMIT,
    schema: { tags: ['webhooks'], summary: '外部Webhook受信(署名検証→保存→非同期処理)', params: webhookParams },
  };
  app.post('/webhooks/:provider', webhookOpts, (req, reply) => receiveWebhook(req, reply));
  app.post('/webhooks/:provider/:key', webhookOpts, (req, reply) => receiveWebhook(req, reply));
};

export default plugin;
