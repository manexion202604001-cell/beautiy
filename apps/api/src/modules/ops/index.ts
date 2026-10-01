import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { idParam } from '../../lib/schemas.js';
import { searchAuditLogs } from './audit-search.js';
import * as exportsSvc from './exports.js';
import * as flags from './flags.js';
import './retention.js';
import { auditSearchSchema, createExportSchema, flagKeyParam, listExportsSchema, listJobsSchema, listWebhookEventsSchema, putFlagSchema } from './schemas.js';
import * as svc from './service.js';

const tags = ['ops'];

/**
 * 運用管理 (要件 16): failure dashboard, DLQ, webhook reprocessing, health, audit search,
 * data exports, feature flags. Retention cleanup runs as a daily periodic job.
 */
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.get('/ops/dashboard', { schema: { tags, summary: '障害ダッシュボード(失敗Webhook・DLQ・外部連携エラー・未解決競合・送信失敗)' } }, (req) => req.tx((ctx) => svc.dashboard(ctx)));
  app.get('/ops/health', { schema: { tags, summary: 'キュー滞留・ワーカー遅延' } }, (req) => req.tx((ctx) => svc.health(ctx)));

  app.get('/ops/jobs', { schema: { tags, summary: 'ジョブ一覧(DLQ)', querystring: listJobsSchema } }, (req) => req.tx((ctx) => svc.listJobs(ctx, req.query)));
  app.post('/ops/jobs/:id/retry', { schema: { tags, summary: 'DLQジョブの再実行', params: idParam } }, (req) => req.tx((ctx) => svc.retryJob(ctx, req.params.id)));
  app.post('/ops/jobs/:id/cancel', { schema: { tags, summary: 'ジョブの取消', params: idParam } }, (req) => req.tx((ctx) => svc.cancelJob(ctx, req.params.id)));

  app.get('/ops/webhook-events', { schema: { tags, summary: 'Webhook受信履歴', querystring: listWebhookEventsSchema } }, (req) => req.tx((ctx) => svc.listWebhookEvents(ctx, req.query)));
  app.post('/ops/webhook-events/:id/reprocess', { schema: { tags, summary: 'Webhookの再処理', params: idParam } }, (req) =>
    req.tx((ctx) => svc.reprocessWebhookEvent(ctx, req.params.id)),
  );

  app.get('/audit-logs', { schema: { tags: ['audit'], summary: '監査ログ検索(誰がいつ何を閲覧・変更したか)', querystring: auditSearchSchema } }, (req) =>
    req.tx((ctx) => searchAuditLogs(ctx, req.query)),
  );

  app.post('/exports', { config: { idempotent: true }, schema: { tags: ['exports'], summary: 'データエクスポート依頼(非同期・監査対象)', body: createExportSchema } }, async (req, reply) =>
    reply.status(202).send(await req.tx((ctx) => exportsSvc.createExport(ctx, req.body))),
  );
  app.get('/exports', { schema: { tags: ['exports'], summary: 'エクスポート一覧', querystring: listExportsSchema } }, (req) => req.tx((ctx) => exportsSvc.listExports(ctx, req.query)));
  app.get('/exports/:id', { schema: { tags: ['exports'], params: idParam } }, (req) => req.tx((ctx) => exportsSvc.getExport(ctx, req.params.id)));
  app.get('/exports/:id/download', { schema: { tags: ['exports'], summary: 'ダウンロードURL(短時間有効の署名付きURL)', params: idParam } }, (req) =>
    req.tx((ctx) => exportsSvc.downloadExport(ctx, req.params.id)),
  );

  app.get('/feature-flags', { schema: { tags, summary: '機能フラグ一覧(グローバル既定値+法人上書き)' } }, (req) => req.tx((ctx) => flags.listFlags(ctx)));
  app.put('/feature-flags/:key', { schema: { tags, summary: '機能フラグの法人上書き', params: flagKeyParam, body: putFlagSchema } }, (req) =>
    req.tx((ctx) => flags.setFlag(ctx, req.params.key, req.body)),
  );
  app.delete('/feature-flags/:key', { schema: { tags, summary: '法人上書きの解除(グローバル既定値に戻す)', params: flagKeyParam } }, (req) =>
    req.tx((ctx) => flags.clearFlag(ctx, req.params.key)),
  );
};

export default plugin;
