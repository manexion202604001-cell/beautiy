import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Ctx } from '../../auth/actor.js';
import { customersReport, ltvReport, repeatRateReport } from './customers.js';
import {
  CATEGORY_HEADERS,
  CHANNEL_HEADERS,
  CUSTOMER_HEADERS,
  DASHBOARD_HEADERS,
  exportReportCsv,
  LTV_HEADERS,
  MENU_HEADERS,
  REPEAT_HEADERS,
  salesCsv,
  STAFF_HEADERS,
} from './export.js';
import './jobs.js'; // job handlers, periodic nightly rebuild, event subscribers
import { channelsReport, dashboard, menusReport, requestRebuild, salesReport, staffReport } from './reports.js';
import { channelsQuery, customersQuery, dashboardQuery, ltvQuery, menusQuery, rebuildBody, repeatRateQuery, salesQuery, staffQuery } from './schemas.js';

const tags = ['analytics'];

function sendCsv(reply: FastifyReply, name: string, csv: string) {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="analytics-${name}-${new Date().toISOString().slice(0, 10)}.csv"`)
    .send(csv);
}

/**
 * Runs a report; with ?format=csv converts it to CSV in the same transaction (permission export.data + audit export.csv).
 */
async function respond<R>(
  req: { tx<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T>; query: { format?: 'json' | 'csv' } & Record<string, unknown> },
  reply: FastifyReply,
  name: string,
  run: (ctx: Ctx) => Promise<R>,
  toCsv: (report: R) => { headers: { key: string; label: string }[]; rows: Record<string, unknown>[] },
) {
  if (req.query.format !== 'csv') return req.tx(run);
  const csv = await req.tx(async (ctx) => {
    const report = await run(ctx);
    const { headers, rows } = toCsv(report);
    const { format: _f, ...filter } = req.query;
    return exportReportCsv(ctx, name, headers, rows, filter);
  });
  return sendCsv(reply, name, csv);
}

const plugin: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/analytics/sales',
    { schema: { tags, summary: '売上分析(期間比較・店舗/スタッフ別・CSV)', description: '閲覧は監査対象(sales.view)。スタイリストは自分の売上のみ。', querystring: salesQuery } },
    (req, reply) => respond(req, reply, 'sales', (ctx) => salesReport(ctx, req.query), salesCsv),
  );

  app.get('/analytics/customers', { schema: { tags, summary: '新規/再来/失客・来店周期', querystring: customersQuery } }, (req, reply) =>
    respond(req, reply, 'customers', (ctx) => customersReport(ctx, req.query), (r) => ({ headers: CUSTOMER_HEADERS, rows: r.rows })),
  );

  app.get('/analytics/repeat-rate', { schema: { tags, summary: '新規リピート率(30/60/90日)', querystring: repeatRateQuery } }, (req, reply) =>
    respond(
      req,
      reply,
      'repeat-rate',
      (ctx) => repeatRateReport(ctx, req.query),
      (r) => ({
        headers: REPEAT_HEADERS,
        rows: r.cohorts.map((c) => ({ cohort: c.cohort, cohortSize: c.cohortSize, d30: c.windows.d30?.rate, d60: c.windows.d60?.rate, d90: c.windows.d90?.rate, returnedEverRate: c.returnedEverRate })),
      }),
    ),
  );

  app.get('/analytics/ltv', { schema: { tags, summary: 'LTV(獲得経路/店舗/初回来店月別・上位顧客)', querystring: ltvQuery } }, (req, reply) =>
    respond(
      req,
      reply,
      'ltv',
      (ctx) => ltvReport(ctx, req.query),
      (r) => {
        const table = req.query.csvTable;
        const rows = table === 'source' ? r.bySource : table === 'shop' ? r.byShop : table === 'cohort' ? r.byCohort : r.topCustomers;
        return { headers: LTV_HEADERS[table], rows: rows as Record<string, unknown>[] };
      },
    ),
  );

  app.get('/analytics/menus', { schema: { tags, summary: 'メニュー構成比', querystring: menusQuery } }, (req, reply) =>
    respond(
      req,
      reply,
      'menus',
      (ctx) => menusReport(ctx, req.query),
      (r) => (req.query.csvTable === 'category' ? { headers: CATEGORY_HEADERS, rows: r.categories } : { headers: MENU_HEADERS, rows: r.menus }),
    ),
  );

  app.get('/analytics/staff', { schema: { tags, summary: 'スタッフ生産性(指名率・稼働率・時間あたり売上)', querystring: staffQuery } }, (req, reply) =>
    respond(req, reply, 'staff', (ctx) => staffReport(ctx, req.query), (r) => ({ headers: STAFF_HEADERS, rows: r.rows })),
  );

  app.get('/analytics/channels', { schema: { tags, summary: '予約経路別売上', querystring: channelsQuery } }, (req, reply) =>
    respond(req, reply, 'channels', (ctx) => channelsReport(ctx, req.query), (r) => ({ headers: CHANNEL_HEADERS, rows: r.rows })),
  );

  app.get('/analytics/dashboard', { schema: { tags, summary: '本日のKPI・月間目標進捗', querystring: dashboardQuery } }, (req, reply) =>
    respond(
      req,
      reply,
      'dashboard',
      (ctx) => dashboard(ctx, req.query),
      (r) => ({
        headers: DASHBOARD_HEADERS,
        rows: r.shops.map((s) => ({
          shopName: s.shopName,
          ...s.today,
          mtdSales: s.monthToDate.sales,
          target: s.monthToDate.target,
          achievementRate: s.monthToDate.achievementRate,
        })),
      }),
    ),
  );

  app.post('/analytics/rebuild', { schema: { tags, summary: '集計テーブルの再計算(運用)', body: rebuildBody } }, async (req, reply) =>
    reply.status(202).send(await req.tx((ctx) => requestRebuild(ctx, req.body))),
  );
};

export default plugin;
