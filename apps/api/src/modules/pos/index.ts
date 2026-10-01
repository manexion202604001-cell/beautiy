import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { onEvent } from '../../lib/events.js';
import { idParam, uuid } from '../../lib/schemas.js';
import './points.js'; // registers the daily point-expiry job
import * as register from './register.js';
import { getReceipt, issueReceipt, receiptHtml } from './receipts.js';
import { dailyReport, exportTransactionItemsCsv, exportTransactionsCsv } from './reports.js';
import {
  addPaymentSchema,
  cashMovementSchema,
  closeRegisterSchema,
  createTransactionSchema,
  currentRegisterSchema,
  dailyReportSchema,
  exportTransactionsSchema,
  listRegisterSchema,
  listTransactionsSchema,
  openRegisterSchema,
  pointsSchema,
  receiptSchema,
  refundTransactionSchema,
  replaceItemsSchema,
  voidSchema,
} from './schemas.js';
import * as tx from './transactions.js';

// Online payment results / refunds made outside the POS flow (payments API, provider webhooks)
onEvent<{ transactionId: string | null }>('payment.succeeded', async (ctx, e) => {
  if (!e.payload.transactionId) return;
  const t = await ctx.trx.selectFrom('transactions').select('status').where('id', '=', e.payload.transactionId).executeTakeFirst();
  if (t?.status === 'draft') await tx.recomputePaid(ctx, e.payload.transactionId);
});
onEvent<{ transactionId: string | null }>('payment.refunded', async (ctx, e) => {
  if (!e.payload.transactionId || tx.isRefundInProgress(ctx)) return;
  const t = await ctx.trx.selectFrom('transactions').select('status').where('id', '=', e.payload.transactionId).executeTakeFirst();
  if (!t) return;
  if (t.status === 'draft') await tx.recomputePaid(ctx, e.payload.transactionId);
  else await tx.syncRefundState(ctx, e.payload.transactionId, { emitEvent: true });
});

const tags = ['pos'];
const headerKey = (h: Record<string, unknown>) => (typeof h['idempotency-key'] === 'string' ? (h['idempotency-key'] as string) : undefined);
const csvName = (kind: string) => `attachment; filename="${kind}-${new Date().toISOString().slice(0, 10)}.csv"`;

const plugin: FastifyPluginAsyncZod = async (app) => {
  // ------------------------------------------------------------- register sessions (レジ)
  app.post('/register-sessions/open', { config: { idempotent: true }, schema: { tags, summary: 'レジ開局', body: openRegisterSchema } }, async (req, reply) =>
    reply.status(201).send(await req.tx((ctx) => register.openRegister(ctx, req.body))),
  );
  app.get('/register-sessions/current', { schema: { tags, summary: '開局中のレジ(現在の想定現金残高つき)', querystring: currentRegisterSchema } }, (req) =>
    req.tx((ctx) => register.currentRegister(ctx, req.query.shopId)),
  );
  app.get('/register-sessions', { schema: { tags, summary: 'レジ開局/締め履歴', querystring: listRegisterSchema } }, (req) => req.tx((ctx) => register.listRegisterSessions(ctx, req.query)));
  app.get('/register-sessions/:id', { schema: { tags, summary: 'レジセッション詳細', params: idParam } }, (req) => req.tx((ctx) => register.getRegisterSession(ctx, req.params.id)));
  app.post(
    '/register-sessions/:id/cash-movements',
    { config: { idempotent: true }, schema: { tags, summary: '入金/出金(両替・小口経費)', params: idParam, body: cashMovementSchema } },
    async (req, reply) => reply.status(201).send(await req.tx((ctx) => register.addCashMovement(ctx, req.params.id, req.body))),
  );
  app.post(
    '/register-sessions/:id/close',
    { config: { idempotent: true }, schema: { tags, summary: 'レジ締め(想定残高・差額・集計)', params: idParam, body: closeRegisterSchema } },
    (req) => req.tx((ctx) => register.closeRegister(ctx, req.params.id, req.body)),
  );

  // ------------------------------------------------------------- transactions (会計)
  app.get('/transactions', { schema: { tags, summary: '会計一覧', querystring: listTransactionsSchema } }, (req) => req.tx((ctx) => tx.listTransactions(ctx, req.query)));
  app.get('/transactions/export.csv', { schema: { tags, summary: '会計CSV(監査対象)', querystring: exportTransactionsSchema } }, async (req, reply) => {
    const csv = await req.tx((ctx) => exportTransactionsCsv(ctx, req.query));
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', csvName('transactions')).send(csv);
  });
  app.get('/transaction-items/export.csv', { schema: { tags, summary: '会計明細CSV(担当者配賦つき・監査対象)', querystring: exportTransactionsSchema } }, async (req, reply) => {
    const csv = await req.tx((ctx) => exportTransactionItemsCsv(ctx, req.query));
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', csvName('transaction-items')).send(csv);
  });
  app.post(
    '/transactions',
    { config: { idempotent: true }, schema: { tags, summary: '会計作成(下書き)', description: 'appointmentId指定時は予約メニュー・指名料・クーポン・担当者配賦をプリセット', body: createTransactionSchema } },
    async (req, reply) => reply.status(201).send(await req.tx((ctx) => tx.createTransaction(ctx, req.body))),
  );
  app.get('/transactions/:id', { schema: { tags, summary: '会計詳細(明細・担当配賦・支払・領収書)', params: idParam } }, (req) => req.tx((ctx) => tx.getTransaction(ctx, req.params.id)));
  app.put(
    '/transactions/:id/items',
    { schema: { tags, summary: '明細の置き換え(楽観ロック: version必須・再計算)', params: idParam, body: replaceItemsSchema } },
    (req) => req.tx((ctx) => tx.replaceItems(ctx, req.params.id, req.body)),
  );
  app.post('/transactions/:id/points', { config: { idempotent: true }, schema: { tags, summary: 'ポイント利用(利用数を設定)', params: idParam, body: pointsSchema } }, (req) =>
    req.tx((ctx) => tx.setPointUse(ctx, req.params.id, req.body.use)),
  );
  app.post(
    '/transactions/:id/payments',
    { config: { idempotent: true }, schema: { tags, summary: '支払追加(現金/カード/電子マネー/QR/店舗独自/ポイント)', description: 'idempotencyKey必須。現金はお釣り計算。online=trueのカードは決済プロバイダ経由。', params: idParam, body: addPaymentSchema } },
    async (req, reply) => reply.status(201).send(await req.tx((ctx) => tx.addPayment(ctx, req.params.id, req.body, headerKey(req.headers)))),
  );
  app.delete('/transactions/:id/payments/:paymentId', { schema: { tags, summary: '未確定会計の支払取消', params: z.object({ id: uuid, paymentId: uuid }) } }, (req) =>
    req.tx((ctx) => tx.removePayment(ctx, req.params.id, req.params.paymentId)),
  );
  app.post('/transactions/:id/complete', { config: { idempotent: true }, schema: { tags, summary: '会計確定(冪等)', params: idParam } }, (req) => req.tx((ctx) => tx.completeTransaction(ctx, req.params.id)));
  app.post('/transactions/:id/void', { config: { idempotent: true }, schema: { tags, summary: '会計取消(当日/レジ締め前)・下書き破棄', params: idParam, body: voidSchema } }, (req) =>
    req.tx((ctx) => tx.voidTransaction(ctx, req.params.id, req.body.reason)),
  );
  app.post(
    '/transactions/:id/refunds',
    { config: { idempotent: true }, schema: { tags, summary: '返品・返金(一部/全額)', description: 'pos.refund 権限。idempotencyKey必須。', params: idParam, body: refundTransactionSchema } },
    (req) => req.tx((ctx) => tx.refundTransaction(ctx, req.params.id, req.body, headerKey(req.headers))),
  );

  // ------------------------------------------------------------- receipts (レシート/領収書)
  app.post('/transactions/:id/receipts', { config: { idempotent: true }, schema: { tags, summary: 'レシート/領収書発行(2回目以降は再発行)', params: idParam, body: receiptSchema } }, async (req, reply) =>
    reply.status(201).send(await req.tx((ctx) => issueReceipt(ctx, req.params.id, req.body))),
  );
  app.get('/receipts/:id', { schema: { tags, summary: 'レシート/領収書', params: idParam } }, (req) => req.tx((ctx) => getReceipt(ctx, req.params.id)));
  app.get('/receipts/:id/html', { schema: { tags, summary: '印刷用HTML', params: idParam } }, async (req, reply) => {
    const html = await req.tx((ctx) => receiptHtml(ctx, req.params.id));
    return reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  });

  // ------------------------------------------------------------- reports
  app.get('/pos/daily-report', { schema: { tags, summary: '日報(支払方法別・担当者別・新規/再来・税・返金・レジ差額)', querystring: dailyReportSchema } }, (req) =>
    req.tx((ctx) => dailyReport(ctx, req.query)),
  );
};

export default plugin;
