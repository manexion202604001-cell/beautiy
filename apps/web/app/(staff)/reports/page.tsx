import { requirePage } from '@/lib/server/session';
import { PageHeader, Card, Stat, Empty } from '@/components/ui';
import { yen } from '@/lib/format';
import { SOURCE_LABEL } from '@/lib/server/booking';
import {
  nominationSplit, paymentBreakdown, previousPeriod, salesByShop, salesSeries, salesTotals, sourcePerformance,
} from '@/lib/server/analytics';
import { ColumnChart, Delta, HBarList, SERIES_COLORS, SplitBar } from './_components/charts';
import { ExportLink, periodText, ReportFilters, ReportTabs } from './_components/Filters';
import { reportScope, type SP } from './_components/scope';
import { bucketLabel, bucketTip, fmtCount, fmtPct, PAYMENT_LABEL } from './_components/labels';

export const metadata = { title: '売上レポート' };

export default async function SalesReportPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePage('report.read');
  const sp = await searchParams;
  const scope = reportScope(ctx, sp);
  const { period: p, shopIds } = scope;
  const orgId = ctx.org.id;
  const [totals, prev, series, pays, nom, sources, byShop] = await Promise.all([
    salesTotals(orgId, shopIds, p),
    salesTotals(orgId, shopIds, previousPeriod(p)),
    salesSeries(orgId, shopIds, p, scope.gran, scope.mode === 'compare'),
    paymentBreakdown(orgId, shopIds, p),
    nominationSplit(orgId, shopIds, p),
    sourcePerformance(orgId, shopIds, p),
    scope.multi && scope.mode !== 'shop' ? salesByShop(orgId, shopIds, p) : Promise.resolve([]),
  ]);
  const canExport = ctx.can('report.export');
  const chartSeries = scope.mode === 'compare'
    ? scope.shops.slice(0, SERIES_COLORS.length).map((s, i) => ({ key: s.id, label: s.name, color: SERIES_COLORS[i], values: series.buckets.map((b) => series.points.find((x) => x.bucket === b && x.shopId === s.id)?.net ?? 0) }))
    : [{ key: 'net', label: '純売上', color: SERIES_COLORS[0], values: series.buckets.map((b) => series.points.find((x) => x.bucket === b)?.net ?? 0) }];
  const payTotal = pays.reduce((s, x) => s + x.amount, 0);
  const srcMaxRevenue = Math.max(0, ...sources.map((s) => s.revenue));

  return (
    <>
      <PageHeader
        title="分析・レポート"
        sub={`${scope.label} ・ ${periodText(scope)}`}
        actions={<>
          <ExportLink kind="sales-daily" sp={sp} label="日別売上CSV" enabled={canExport} />
          <ExportLink kind="transactions" sp={sp} label="会計明細CSV" enabled={canExport} />
        </>}
      />
      <ReportTabs active="sales" sp={sp} />
      <ReportFilters path="/reports" sp={sp} scope={scope} showGran />

      <div className="grid-4">
        <Stat label="純売上（返金控除後）" value={yen(totals.net)} sub={<Delta cur={totals.net} prev={prev.net} suffix={p.range === 'thisMonth' ? '前月同期間比' : '前期間比'} />} />
        <Stat label="客数" value={`${fmtCount(totals.customers + totals.walkIns)}人`} sub={<Delta cur={totals.customers + totals.walkIns} prev={prev.customers + prev.walkIns} />} />
        <Stat label="客単価" value={yen(totals.avgTicket)} sub={<Delta cur={totals.avgTicket} prev={prev.avgTicket} />} />
        <Stat label="会計件数" value={`${fmtCount(totals.txCount)}件`} sub={<Delta cur={totals.txCount} prev={prev.txCount} />} />
      </div>

      <Card className="section" title={scope.mode === 'compare' ? '店舗別 売上推移（純売上）' : '売上推移（純売上）'}>
        <ColumnChart
          ariaLabel={`${scope.gran === 'day' ? '日別' : '月別'}の純売上推移`}
          labels={series.buckets.map((b) => bucketLabel(b, scope.gran))}
          tipLabels={series.buckets.map((b) => bucketTip(b, scope.gran))}
          series={chartSeries}
          tableHead={scope.gran === 'day' ? '日付' : '月'}
        />
      </Card>

      <div className="grid-2 section">
        <Card title="売上の内訳">
          <dl className="kv report-kv">
            <dt>総売上（値引前）</dt><dd className="num">{yen(totals.gross)}</dd>
            <dt>値引・クーポン</dt><dd className="num">−{yen(totals.discounts)}</dd>
            <dt>ポイント利用</dt><dd className="num">−{yen(totals.pointsUsed)}</dd>
            <dt>売上（税込）</dt><dd className="num">{yen(totals.sales)}</dd>
            <dt>返金</dt><dd className="num">−{yen(totals.refunds)}</dd>
            <dt><b>純売上</b></dt><dd className="num"><b>{yen(totals.net)}</b></dd>
            <dt>うち消費税（内税）</dt><dd className="num">{yen(totals.tax)}</dd>
          </dl>
          <p className="sub" style={{ marginTop: 10 }}>返金は返金日の売上から控除しています。会計日時は店舗のタイムゾーンで集計します。</p>
        </Card>
        <Card title="構成比">
          <div className="stack">
            <div><div className="label">技術 / 店販</div>
              <SplitBar ariaLabel="技術と店販の売上構成" parts={[{ label: '技術（施術）', value: totals.service, color: SERIES_COLORS[0] }, { label: '店販', value: totals.retail, color: SERIES_COLORS[1] }, ...(totals.other ? [{ label: 'その他', value: totals.other, color: SERIES_COLORS[2] }] : [])]} />
            </div>
            <div><div className="label">新規 / 再来（顧客数・期間内に初来店＝新規）</div>
              <SplitBar ariaLabel="新規客と再来客" format={(n) => `${fmtCount(n)}人`} parts={[{ label: '新規', value: totals.newCustomers, color: SERIES_COLORS[2] }, { label: '再来', value: totals.repeatCustomers, color: SERIES_COLORS[0] }]} />
            </div>
            <div><div className="label">指名 / フリー（技術売上）</div>
              <SplitBar ariaLabel="指名とフリーの技術売上" parts={[{ label: `指名（${fmtCount(nom.nominatedTickets)}件）`, value: nom.nominatedSales, color: SERIES_COLORS[0] }, { label: `フリー（${fmtCount(nom.freeTickets)}件）`, value: nom.freeSales, color: SERIES_COLORS[3] }]} />
            </div>
          </div>
        </Card>
      </div>

      {byShop.length > 0 && (
        <Card className="section" flush title="店舗別サマリー">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>店舗</th><th className="num">売上</th><th className="num">返金</th><th className="num">純売上</th><th className="num">構成比</th><th className="num">会計件数</th><th className="num">顧客数</th><th className="num">客単価</th></tr></thead>
              <tbody>
                {byShop.map((r) => (
                  <tr key={r.shopId}>
                    <td>{ctx.shops.find((s) => s.id === r.shopId)?.name}</td>
                    <td className="num">{yen(r.sales)}</td><td className="num">{yen(r.refunds)}</td><td className="num"><b>{yen(r.net)}</b></td>
                    <td className="num">{totals.net ? fmtPct(r.net / totals.net) : '—'}</td>
                    <td className="num">{fmtCount(r.tx)}</td><td className="num">{fmtCount(r.customers)}</td><td className="num">{yen(r.avgTicket)}</td>
                  </tr>
                ))}
                <tr className="total-row"><td>合計</td><td className="num">{yen(totals.sales)}</td><td className="num">{yen(totals.refunds)}</td><td className="num"><b>{yen(totals.net)}</b></td><td className="num">100%</td><td className="num">{fmtCount(totals.txCount)}</td><td className="num">{fmtCount(totals.customers)}</td><td className="num">{yen(totals.avgTicket)}</td></tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="split section">
        <Card flush title="予約経路別の実績">
          {sources.length === 0 ? <Empty title="この期間の予約はありません" /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>経路</th><th className="num">予約数</th><th className="num">来店完了</th><th className="num">キャンセル</th><th className="num">無断</th><th>売上</th></tr></thead>
                <tbody>
                  {sources.map((s) => (
                    <tr key={s.source}>
                      <td>{SOURCE_LABEL[s.source as keyof typeof SOURCE_LABEL] ?? s.source}</td>
                      <td className="num">{fmtCount(s.appointments)}</td>
                      <td className="num">{fmtCount(s.completed)}<span className="sub"> ({s.appointments ? fmtPct(s.completed / s.appointments, 0) : '—'})</span></td>
                      <td className="num">{fmtCount(s.cancelled)}</td>
                      <td className="num">{fmtCount(s.noShow)}</td>
                      <td style={{ minWidth: 180 }}>
                        <div className="between"><span className="num">{yen(s.revenue)}</span></div>
                        <div className="bar"><span style={{ width: `${srcMaxRevenue ? Math.max(1, (s.revenue / srcMaxRevenue) * 100) : 0}%` }} /></div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="支払方法">
          {pays.length === 0 ? <Empty title="この期間の入金はありません" /> : (
            <HBarList ariaLabel="支払方法別の入金額" format={yen}
              rows={pays.map((x) => ({ key: x.method, label: PAYMENT_LABEL[x.method] ?? x.method, value: x.amount, sub: `${payTotal ? fmtPct(x.amount / payTotal, 0) : ''}・${fmtCount(x.count)}件` }))} />
          )}
        </Card>
      </div>
    </>
  );
}
