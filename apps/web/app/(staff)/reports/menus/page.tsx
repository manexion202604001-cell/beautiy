import { requirePage } from '@/lib/server/session';
import { PageHeader, Card, Empty } from '@/components/ui';
import { yen } from '@/lib/format';
import { menuRanking } from '@/lib/server/analytics';
import { HBarList, SERIES_COLORS } from '../_components/charts';
import { periodText, ReportFilters, ReportTabs } from '../_components/Filters';
import { one, qs, reportScope, type SP } from '../_components/scope';
import { fmtCount, fmtPct } from '../_components/labels';
import Link from 'next/link';

export const metadata = { title: 'メニューランキング' };

export default async function MenuReportPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePage('report.read');
  const sp = await searchParams;
  const scope = reportScope(ctx, sp);
  const by = one(sp.by) === 'count' ? 'count' : 'revenue';
  const [services, retail] = await Promise.all([
    menuRanking(ctx.org.id, scope.shopIds, scope.period, 'SERVICE', 50),
    menuRanking(ctx.org.id, scope.shopIds, scope.period, 'RETAIL', 30),
  ]);
  const sort = <T extends { revenue: number; count: number }>(l: T[]) => l.slice().sort((a, b) => by === 'count' ? b.count - a.count || b.revenue - a.revenue : b.revenue - a.revenue);
  const svc = sort(services), ret = sort(retail);
  const svcTotal = services.reduce((s, r) => s + r.revenue, 0), retTotal = retail.reduce((s, r) => s + r.revenue, 0);

  const table = (list: typeof svc, total: number, unit: string) => (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th style={{ width: 44 }}>順位</th><th>名称</th><th className="num">{unit}</th><th className="num">売上</th><th className="num">構成比</th><th className="num">平均単価</th></tr></thead>
        <tbody>
          {list.map((r, i) => (
            <tr key={r.key}>
              <td className="num">{i + 1}</td><td>{r.name}</td><td className="num">{fmtCount(r.count)}</td><td className="num">{yen(r.revenue)}</td>
              <td className="num">{total ? fmtPct(r.revenue / total) : '—'}</td><td className="num">{r.count ? yen(Math.round(r.revenue / r.count)) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <PageHeader title="分析・レポート" sub={`${scope.label} ・ ${periodText(scope)}`} />
      <ReportTabs active="menus" sp={sp} />
      <ReportFilters path="/reports/menus" sp={sp} scope={scope} compare={false} />
      <div className="row-wrap" style={{ marginBottom: 12 }}>
        <span className="sub">並び順</span>
        <div className="seg">
          <Link href={`/reports/menus${qs(sp, { by: undefined })}`} className={by === 'revenue' ? 'active' : ''}>売上順</Link>
          <Link href={`/reports/menus${qs(sp, { by: 'count' })}`} className={by === 'count' ? 'active' : ''}>件数順</Link>
        </div>
      </div>
      <div className="split">
        <Card flush title="技術メニュー">
          {svc.length === 0 ? <Empty title="この期間の技術売上はありません" /> : table(svc, svcTotal, '件数')}
        </Card>
        <div className="stack">
          <Card title={`上位メニュー（${by === 'count' ? '件数' : '売上'}）`}>
            {svc.length === 0 ? <Empty title="データなし" /> : (
              <HBarList ariaLabel="上位メニュー" color={SERIES_COLORS[0]} format={by === 'count' ? (n) => `${fmtCount(n)}件` : yen}
                rows={svc.slice(0, 8).map((r) => ({ key: r.key, label: r.name, value: by === 'count' ? r.count : r.revenue }))} />
            )}
          </Card>
          <Card flush title="店販商品">
            {ret.length === 0 ? <Empty title="この期間の店販売上はありません" /> : table(ret, retTotal, '数量')}
          </Card>
        </div>
      </div>
      <p className="sub section">売上は会計全体の値引・ポイントを明細に按分した税込金額です（返金前）。メニュー名の変更前の会計は旧名称で集計されます。</p>
    </>
  );
}
