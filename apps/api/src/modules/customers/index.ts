import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { idParam, uuid } from '../../lib/schemas.js';
import { dismissDuplicate, findDuplicateCandidates, listDuplicatePairs } from './duplicates.js';
import { assertCustomerAccess } from './access.js';
import { listMergeLogs, mergeCustomers, undoMerge } from './merge.js';
import * as svc from './service.js';
import { createCustomerSchema, memoSchema, mergeSchema, searchCustomersSchema, updateCustomerSchema, updateMemoSchema } from './schemas.js';

const tags = ['customers'];

const plugin: FastifyPluginAsyncZod = async (app) => {
  app.get('/customers', { schema: { tags, summary: '顧客検索', querystring: searchCustomersSchema } }, (req) =>
    req.tx((ctx) => svc.searchCustomers(ctx, req.query)),
  );
  app.post('/customers', { config: { idempotent: true }, schema: { tags, summary: '顧客作成(重複候補を返却)', body: createCustomerSchema } }, async (req, reply) => {
    const result = await req.tx((ctx) => svc.createCustomer(ctx, req.body));
    return reply.status(201).send(result);
  });
  app.get('/customers/export.csv', { schema: { tags, summary: '顧客CSVエクスポート(監査対象)', querystring: searchCustomersSchema } }, async (req, reply) => {
    const csv = await req.tx((ctx) => svc.exportCustomersCsv(ctx, req.query));
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(csv);
  });
  app.get('/customers/duplicates', { schema: { tags, summary: '重複候補ペア一覧(名寄せ)', querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }) } }, (req) =>
    req.tx((ctx) => listDuplicatePairs(ctx, req.query.limit)),
  );
  app.post('/customers/duplicates/dismiss', { schema: { tags, summary: '重複候補の除外', body: z.object({ customerIdA: uuid, customerIdB: uuid }) } }, async (req, reply) => {
    await req.tx((ctx) => dismissDuplicate(ctx, req.body.customerIdA, req.body.customerIdB));
    return reply.status(204).send();
  });
  app.get('/customers/:id', { schema: { tags, summary: '顧客詳細(閲覧は監査対象)', params: idParam } }, (req) => req.tx((ctx) => svc.getCustomer(ctx, req.params.id)));
  app.patch('/customers/:id', { schema: { tags, summary: '顧客更新', params: idParam, body: updateCustomerSchema } }, (req) =>
    req.tx((ctx) => svc.updateCustomer(ctx, req.params.id, req.body)),
  );
  app.delete('/customers/:id', { schema: { tags, summary: '顧客削除(論理削除)', params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => svc.deleteCustomer(ctx, req.params.id));
    return reply.status(204).send();
  });
  app.get('/customers/:id/duplicates', { schema: { tags, summary: 'この顧客の重複候補', params: idParam } }, (req) =>
    req.tx(async (ctx) => {
      await assertCustomerAccess(ctx, req.params.id);
      return findDuplicateCandidates(ctx, req.params.id);
    }),
  );
  app.post(
    '/customers/:id/merge',
    { config: { idempotent: true }, schema: { tags, summary: '顧客マージ(sourceをこの顧客へ統合)', params: idParam, body: mergeSchema } },
    (req) => req.tx((ctx) => mergeCustomers(ctx, req.params.id, req.body.sourceCustomerId, { reason: req.body.reason })),
  );
  app.get('/customers/:id/merge-logs', { schema: { tags, summary: '統合履歴', params: idParam } }, (req) => req.tx((ctx) => listMergeLogs(ctx, req.params.id)));
  app.post('/customer-merges/:id/undo', { schema: { tags, summary: '統合の取り消し', params: idParam } }, (req) => req.tx((ctx) => undoMerge(ctx, req.params.id)));
  app.get('/customers/:id/visits', { schema: { tags, summary: '来店履歴', params: idParam } }, (req) => req.tx((ctx) => svc.customerVisits(ctx, req.params.id)));
  app.get('/customers/:id/timeline', { schema: { tags, summary: '顧客タイムライン', params: idParam } }, (req) => req.tx((ctx) => svc.customerTimeline(ctx, req.params.id)));
  app.put('/customers/:id/tags', { schema: { tags, summary: 'タグ設定', params: idParam, body: z.object({ tagIds: z.array(uuid) }) } }, (req) =>
    req.tx((ctx) => svc.setCustomerTags(ctx, req.params.id, req.body.tagIds)),
  );
  app.delete('/customers/:id/identities/:identityId', { schema: { tags, summary: '外部ID連携解除', params: z.object({ id: uuid, identityId: uuid }) } }, async (req, reply) => {
    await req.tx((ctx) => svc.unlinkIdentity(ctx, req.params.id, req.params.identityId));
    return reply.status(204).send();
  });

  // memos
  app.get('/customers/:id/memos', { schema: { tags, summary: 'メモ一覧(プライベートは本人のみ)', params: idParam } }, (req) => req.tx((ctx) => svc.listMemos(ctx, req.params.id)));
  app.post('/customers/:id/memos', { schema: { tags, params: idParam, body: memoSchema } }, async (req, reply) => {
    const memo = await req.tx((ctx) => svc.createMemo(ctx, req.params.id, req.body));
    return reply.status(201).send(memo);
  });
  app.patch('/customer-memos/:id', { schema: { tags, params: idParam, body: updateMemoSchema } }, (req) => req.tx((ctx) => svc.updateMemo(ctx, req.params.id, req.body)));
  app.delete('/customer-memos/:id', { schema: { tags, params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => svc.deleteMemo(ctx, req.params.id));
    return reply.status(204).send();
  });

  // tags master
  app.get('/tags', { schema: { tags, summary: 'タグ一覧' } }, (req) => req.tx((ctx) => svc.listTags(ctx)));
  app.post('/tags', { schema: { tags, body: z.object({ name: z.string().min(1).max(50), color: z.string().optional() }) } }, async (req, reply) => {
    const tag = await req.tx((ctx) => svc.createTag(ctx, req.body));
    return reply.status(201).send(tag);
  });
  app.patch('/tags/:id', { schema: { tags, params: idParam, body: z.object({ name: z.string().min(1).max(50).optional(), color: z.string().optional() }) } }, (req) =>
    req.tx((ctx) => svc.updateTag(ctx, req.params.id, req.body)),
  );
  app.delete('/tags/:id', { schema: { tags, params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => svc.deleteTag(ctx, req.params.id));
    return reply.status(204).send();
  });
};

export default plugin;
