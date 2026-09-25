import { ROLE_LABEL, type RoleName } from '@salonos/core';
import { requirePage } from '@/lib/server/session';
import { PageHeader, Card, Empty, Badge } from '@/components/ui';
import { yen } from '@/lib/format';
import { staffKpi } from '@/lib/server/analytics';
import { ColumnChart, SERIES_COLORS } from '../_components/charts';
import { ExportLink, periodText, ReportFilters, ReportTabs } from '../_components/Filters';
import { reportScope, type SP } from '../_components/scope';
import { fmtCount, fmtPct } from '../_components/labels';

export const metadata = { title: 'スタッフレポート' };

export default async function StaffReportPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePage('report.read');
  const sp = await searchParams;
  const scope = reportScope(ctx, sp);
  const rows = await staffKpi(ctx.org.id, scope.shopIds, scope.period);
  const withSales = rows.filter((r) => r.total > 0 || r.tickets > 0);
  const sum = rows.reduce((a, r) => ({ total: a.total + r.total, service: a.service + r.service, retail: a.retail + r.retail, tickets: a.tickets + r.tickets }), { total: 0, service: 0, retail: 0, tickets: 0 });

  return (
    <>
      <PageHeader
        title="分析・レポート"
        sub={`${scope.label} ・ ${periodText(scope)}`}
        actions={<ExportLink kind="staff" sp={sp} label="スタッフKPI CSV" enabled={ctx.can('report.export')} />}
      />
      <ReportTabs active="staff" sp={sp} />
      <ReportFilters path="/reports/staff" sp={sp} scope={scope} compare={false} />

      {rows.length === 0 ? (
        <Card><Empty title="対象のスタッフがいません">スタッフ管理からスタッフを招待し、店舗に割り当ててください。</Empty></Card>
      ) : (
        <>
          <Card title="スタッフ別売上（技術・店販）">
            {withSales.length === 0 ? <Empty title="この期間の売上はありません" /> : (
              <ColumnChart
                ariaLabel="スタッフ別の技術売上と店販売上"
                labels={withSales.map((r) => r.name.length > 6 ? r.name.slice(0, 6) + '…' : r.name)}
                tipLabels={withSales.map((r) => r.name)}
                tableHead="スタッフ"
                series={[
                  { key: 'service', label: '技術', color: SERIES_COLORS[0], values: withSales.map((r) => r.service) },
                  { key: 'retail', label: '店販', color: SERIES_COLORS[1], values: withSales.map((r) => r.retail) },
                ]}
              />
            )}
          </Card>

          <Card className="section" flush title="スタッフKPI比較">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>スタッフ</th><th className="num">売上合計</th><th className="num">技術</th><th className="num">店販</th><th className="num">構成比</th>
                    <th className="num">会計数</th><th className="num">担当客数</th><th className="num">客単価</th><th className="num">指名率</th>
                    <th className="num" title="期間内に担当した顧客のうち、その後90日以内に再来店した割合">再来率(90日)</th>
                    <th className="num" title="担当顧客（顧客台帳の担当者）の平均LTV">担当顧客の平均LTV</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.userId} className={r.active ? '' : 'row-muted'}>
                      <td>
                        <div style={{ fontWeight: 700 }}>{r.name}</div>
                        <div className="row-wrap">{r.role && <span className="sub">{ROLE_LABEL[r.role as RoleName]}</span>}{!r.active && <Badge>無効</Badge>}</div>
                      </td>
                      <td className="num"><b>{yen(r.total)}</b></td>
                      <td className="num">{yen(r.service)}</td>
                      <td className="num">{yen(r.retail)}</td>
                      <td className="num">{sum.total ? fmtPct(r.total / sum.total) : '—'}</td>
                      <td className="num">{fmtCount(r.tickets)}</td>
                      <td className="num">{fmtCount(r.customers)}</td>
                      <td className="num">{yen(r.avgTicket)}</td>
                      <td className="num">{r.tickets ? fmtPct(r.nominationRate) : '—'}</td>
                      <td className="num">{r.served ? <>{fmtPct(r.repeatRate)}<div className="sub">{r.returned}/{r.served}人</div></> : '—'}</td>
                      <td className="num">{r.assignedCustomers ? <>{yen(r.avgAssignedLtv)}<div className="sub">{r.assignedCustomers}人</div></> : '—'}</td>
                    </tr>
                  ))}
                  <tr className="total-row">
                    <td>合計</td><td className="num">{yen(sum.total)}</td><td className="num">{yen(sum.service)}</td><td className="num">{yen(sum.retail)}</td><td className="num">100%</td>
                    <td className="num">{fmtCount(sum.tickets)}</td><td /><td className="num">{sum.tickets ? yen(Math.round(sum.total / sum.tickets)) : '—'}</td><td /><td /><td />
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
          <p className="sub section">売上は会計明細の担当スタッフ別に、会計全体の値引・ポイント・返金を按分した金額です（1会計に複数スタッフが関わる場合はそれぞれに計上）。再来率は期間内の担当顧客が、その来店から90日以内に再来店した割合です。</p>
        </>
      )}
    </>
  );
}
