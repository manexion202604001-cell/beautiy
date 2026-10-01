import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { idParam, uuid } from '../../lib/schemas.js';
import * as accounts from './accounts.js';
import './adapters/mock-booking.js';
import * as conflicts from './conflicts.js';
import './mail/adapter.js';
import * as mail from './mail/service.js';
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
  await app.register(async (scope) => {
    const hooks = scope.withTypeProvider<ZodTypeProvider>();
    // inbound-mail services post forms (Mailgun: urlencoded / multipart, SendGrid Inbound Parse: multipart)
    hooks.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
      (req as unknown as { rawBody: string }).rawBody = body as string;
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });
    await hooks.register(multipart, { attachFieldsToBody: 'keyValues', limits: { fileSize: 2 * 1024 * 1024, files: 10 } });
    hooks.post('/webhooks/:provider', webhookOpts, (req, reply) => receiveWebhook(req, reply));
    hooks.post('/webhooks/:provider/:key', webhookOpts, (req, reply) => receiveWebhook(req, reply));
  });

  // ---- e-mail connectors (Hot Pepper / LiME booking-notification mails)
  app.post(
    '/integrations/:id/parse-test',
    {
      schema: {
        tags,
        summary: '予約通知メールの解析テスト(貼り付けたメールの読み取り結果と対応付けを確認)',
        params: idParam,
        body: z.object({ subject: z.string().max(500), text: z.string().max(100_000).optional(), html: z.string().max(500_000).optional() }),
      },
    },
    (req) => req.tx((ctx) => mail.parseTest(ctx, req.params.id, req.body)),
  );
  app.post(
    '/integrations/:id/import-csv',
    {
      bodyLimit: 5 * 1024 * 1024,
      schema: {
        tags,
        summary: '既存予約のCSV取り込み(dryRunで確認→本取り込み)',
        params: idParam,
        body: z.object({ csv: z.string().min(1).max(5_000_000), dryRun: z.boolean().default(true) }),
      },
    },
    (req) => req.tx((ctx) => mail.importCsv(ctx, req.params.id, req.body)),
  );
  app.get(
    '/integrations/manual-blocks',
    { schema: { tags, summary: '手動ブロック依頼(媒体側で枠を止める/再開する作業)', querystring: z.object({ shopId: uuid.optional(), state: z.enum(['open', 'all']).default('open') }) } },
    (req) => req.tx((ctx) => mail.listManualBlocks(ctx, req.query)),
  );
  app.post('/integrations/manual-blocks/:id/done', { schema: { tags, summary: '手動ブロック依頼を対応済みにする', params: idParam } }, (req) =>
    req.tx((ctx) => mail.completeManualBlock(ctx, req.params.id)),
  );
};

export default plugin;
