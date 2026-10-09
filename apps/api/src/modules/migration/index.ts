import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { idParam, uuid } from '../../lib/schemas.js';
import * as svc from './service.js';

const tags = ['migration'];

const importBody = z.object({
  kind: z.enum(['customers', 'visits', 'reservations']),
  csv: z.string().min(1).max(15_000_000),
  shopId: uuid,
  /** field key → column indexes (omitted = suggested from the header row) */
  mapping: z.record(z.string(), z.array(z.number().int().min(0)).max(10)).optional(),
  options: z
    .object({
      onExisting: z.enum(['fill', 'skip']).optional(),
      defaultMarketingOptIn: z.boolean().optional(),
      createMissingCustomers: z.boolean().optional(),
      defaultMenuId: uuid.optional(),
      sendReminders: z.boolean().optional(),
    })
    .optional(),
  fileName: z.string().max(200).optional(),
  sourceLabel: z.string().max(50).optional(),
});

/** 旧システムからのデータ移行 (customers / visit history / future reservations) */
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post('/migration/preview', { bodyLimit: 16 * 1024 * 1024, schema: { tags, summary: '移行データの確認（列の対応付け・行ごとの問題・既存顧客との一致。書き込みなし）', body: importBody } }, (req) =>
    req.tx((ctx) => svc.previewImport(ctx, req.body)),
  );
  app.post(
    '/migration/imports',
    { bodyLimit: 16 * 1024 * 1024, config: { idempotent: true }, schema: { tags, summary: '移行データの取り込み開始（ジョブ）', body: importBody } },
    async (req, reply) => reply.status(202).send(await req.tx((ctx) => svc.startImport(ctx, req.body))),
  );
  app.get('/migration/imports', { schema: { tags, summary: '取り込み履歴' } }, (req) => req.tx((ctx) => svc.listImportJobs(ctx)));
  app.get('/migration/imports/:id', { schema: { tags, summary: '取り込みの状況・結果', params: idParam } }, (req) => req.tx((ctx) => svc.getImportJob(ctx, req.params.id)));
  app.get('/migration/imports/:id/errors.csv', { schema: { tags, summary: '取り込めなかった行（修正して再取り込み用）', params: idParam } }, async (req, reply) => {
    const csv = await req.tx((ctx) => svc.importErrorsCsv(ctx, req.params.id));
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="import-errors-${req.params.id.slice(0, 8)}.csv"`)
      .send(csv);
  });
  app.post('/migration/imports/:id/undo', { schema: { tags, summary: '取り込みの取り消し（取り込み後に使われたデータは残す）', params: idParam } }, (req) =>
    req.tx((ctx) => svc.undoImport(ctx, req.params.id)),
  );
};

export default plugin;
