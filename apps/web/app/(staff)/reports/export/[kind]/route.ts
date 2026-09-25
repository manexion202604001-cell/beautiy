// CSV exports for reports. Requires report.export; every export is audited.
// The LTV customer list carries names and stats only — never contact PII.
import { NextResponse } from 'next/server';
import { LIFECYCLE_LABEL, ROLE_LABEL, toCsv, type RoleName } from '@salonos/core';
import { requireStaff } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';
import { AppError } from '@/lib/server/errors';
import { customerStats, salesSeries, staffKpi } from '@/lib/server/analytics';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { reportScope, type SP } from '../../_components/scope';
import { PAYMENT_LABEL } from '../../_components/labels';

export const dynamic = 'force-dynamic';

const KINDS = ['sales-daily', 'transactions', 'staff', 'ltv'] as const;
type Kind = (typeof KINDS)[number];
const TX_STATUS: Record<string, string> = { PAID: '支払済', PARTIALLY_REFUNDED: '一部返金', REFUNDED: '返金済', VOID: '取消', DRAFT: '下書き' };
const MAX_ROWS = 50_000;

export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (!(KINDS as readonly string[]).includes(kind)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  let ctx;
  try { ctx = await requireStaff('report.export'); } catch (e) {
    if (e instanceof AppError) return new NextResponse(e.message, { status: e.status });
    throw e;
  }
  const sp: SP = Object.fromEntries(new URL(req.url).searchParams.entries());
  const scope = reportScope(ctx, sp);
  const p = scope.period;
  const tz = ctx.shop.timezone;
  const shopName = new Map(ctx.shops.map((s) => [s.id, s.name]));
  let header: string[] = [];
  let rows: (string | number | null)[][] = [];

  switch (kind as Kind) {
    case 'sales-daily': {
      const perShop = scope.mode === 'compare';
      const s = await salesSeries(ctx.org.id, scope.shopIds, p, 'day', perShop);
      header = ['日付', ...(perShop ? ['店舗'] : []), '売上', '返金', '純売上', '会計件数'];
      rows = s.points.map((x) => [x.bucket, ...(perShop ? [shopName.get(x.shopId) ?? ''] : []), x.sales, x.refunds, x.net, x.tx]);
      break;
    }
    case 'transactions': {
      const txs = await prisma.transaction.findMany({
        where: { organizationId: ctx.org.id, shopId: { in: scope.shopIds }, status: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] }, OR: [{ paidAt: { gte: p.from, lt: p.to } }, { paidAt: null, createdAt: { gte: p.from, lt: p.to } }] },
        select: {
          number: true, shopId: true, status: true, subtotal: true, discountTotal: true, pointsUsed: true, total: true, taxTotal: true, refundedTotal: true, paidAt: true, createdAt: true, staffId: true,
          customer: { select: { lastName: true, firstName: true } }, payments: { select: { method: true, amount: true, status: true } },
          items: { select: { kind: true, unitPrice: true, quantity: true, discount: true } },
        },
        orderBy: [{ paidAt: 'asc' }, { number: 'asc' }], take: MAX_ROWS,
      });
      const staff = await prisma.membership.findMany({ where: { organizationId: ctx.org.id }, select: { userId: true, displayName: true } });
      const sn = new Map(staff.map((s) => [s.userId, s.displayName]));
      header = ['会計日時', '会計番号', '店舗', '顧客', '担当', 'ステータス', '技術（明細）', '店販（明細）', '小計', '値引', 'ポイント利用', '合計（税込）', 'うち消費税', '返金額', '支払方法'];
      rows = txs.map((t) => {
        const line = (k: string) => t.items.filter((i) => i.kind === k).reduce((s, i) => s + Math.max(0, i.unitPrice * i.quantity - i.discount), 0);
        return [
          fmtDateTime(t.paidAt ?? t.createdAt, tz), t.number, shopName.get(t.shopId) ?? '', t.customer ? `${t.customer.lastName} ${t.customer.firstName}`.trim() : '（ゲスト）',
          t.staffId ? sn.get(t.staffId) ?? '' : '', TX_STATUS[t.status] ?? t.status, line('SERVICE'), line('RETAIL'), t.subtotal, t.discountTotal, t.pointsUsed, t.total, t.taxTotal, t.refundedTotal,
          t.payments.filter((x) => x.status === 'SUCCEEDED').map((x) => `${PAYMENT_LABEL[x.method] ?? x.method}:${x.amount}`).join(' / '),
        ];
      });
      break;
    }
    case 'staff': {
      const list = await staffKpi(ctx.org.id, scope.shopIds, p);
      header = ['スタッフ', '役割', '売上合計', '技術', '店販', '会計数', '担当客数', '客単価', '指名率(%)', '再来率90日(%)', '担当顧客数', '担当顧客の平均LTV'];
      rows = list.map((r) => [r.name, r.role ? ROLE_LABEL[r.role as RoleName] : '', r.total, r.service, r.retail, r.tickets, r.customers, r.avgTicket, (r.nominationRate * 100).toFixed(1), (r.repeatRate * 100).toFixed(1), r.assignedCustomers, r.avgAssignedLtv]);
      break;
    }
    case 'ltv': {
      const list = await customerStats(ctx.org.id, scope.mode === 'shop' ? ctx.shop.id : null);
      const staff = await prisma.membership.findMany({ where: { organizationId: ctx.org.id }, select: { userId: true, displayName: true } });
      const sn = new Map(staff.map((s) => [s.userId, s.displayName]));
      header = ['顧客ID', '氏名', '状態', 'LTV', '来店回数', '平均単価', '平均来店間隔(日)', '初回来店', '最終来店', '経過日数', '担当', '主担当店舗'];
      rows = list.sort((a, b) => b.ltv - a.ltv).map((r) => [
        r.id, r.name, LIFECYCLE_LABEL[r.lifecycle], r.ltv, r.visitCount, r.avgSpend, r.avgIntervalDays ?? '', r.firstVisitAt ? fmtDate(r.firstVisitAt, tz) : '', r.lastVisitAt ? fmtDate(r.lastVisitAt, tz) : '',
        r.daysSince ?? '', r.assignedStaffId ? sn.get(r.assignedStaffId) ?? '' : '', r.primaryShopId ? shopName.get(r.primaryShopId) ?? '' : '',
      ]);
      break;
    }
  }

  await audit(ctx, 'report.export', 'Report', kind, { kind, scope: scope.mode, shopIds: scope.shopIds, from: p.fromDate, to: p.toDate, rows: rows.length });
  const filename = `${kind}_${kind === 'ltv' ? fmtDate(new Date(), tz).replaceAll('/', '') : `${p.fromDate}_${p.toDate}`}.csv`;
  return new NextResponse(toCsv(header, rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
