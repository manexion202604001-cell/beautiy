import Link from 'next/link';
import { LIFECYCLE_LABEL, type Lifecycle } from '@salonos/core';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { PageHeader, Card, Empty, Badge, Stat } from '@/components/ui';
import { fmtDate, yen } from '@/lib/format';
import { cohortRepeat, customerStats, intervalDistribution, lifecycleCounts, ltvByTag, ltvDistribution } from '@/lib/server/analytics';
import { ColumnChart, HBarList, SERIES_COLORS } from '../_components/charts';
import { ExportLink, ReportFilters, ReportTabs } from '../_components/Filters';
import { one, qs, reportScope, type SP } from '../_components/scope';
import { fmtCount, fmtPct, LC_TONE } from '../_components/labels';

export const metadata = { title: '顧客・LTVレポート' };

const LC_ORDER: Lifecycle[] = ['NEW', 'ACTIVE', 'DUE', 'OVERDUE', 'DORMANT', 'PROSPECT'];
const PAGE = 50;

export default async function CustomerReportPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePage('report.read');
  const sp = await searchParams;
  const scope = reportScope(ctx, sp);
  const shopFilter = scope.mode === 'shop' ? ctx.shop.id : null;
  const now = new Date();
  const [rows, cohorts] = await Promise.all([
    customerStats(ctx.org.id, shopFilter, now),
    cohortRepeat(ctx.org.id, scope.mode === 'shop' ? [ctx.shop.id] : null, ctx.shop.timezone, 12, 90, now),
  ]);
  const [byTag, staff] = await Promise.all([
    ltvByTag(ctx.org.id, rows),
    prisma.membership.findMany({ where: { organizationId: ctx.org.id }, select: { userId: true, displayName: true } }),
  ]);
  const staffName = new Map(staff.map((s) => [s.userId, s.displayName]));
  const visited = rows.filter((r) => r.visitCount > 0);
  const lc = lifecycleCounts(rows);
  const dist = ltvDistribution(rows);
  const intervals = intervalDistribution(rows);
  const avgLtv = visited.length ? Math.round(visited.reduce((s, r) => s + r.ltv, 0) / visited.length) : 0;
  const withI = visited.filter((r) => r.avgIntervalDays !== null);
  const avgInterval = withI.length ? Math.round(withI.reduce((s, r) => s + r.avgIntervalDays!, 0) / withI.length) : null;
  const matureCohorts = cohorts.filter((c) => c.mature && c.newCustomers > 0);
  const overallRepeat = matureCohorts.reduce((s, c) => s + c.newCustomers, 0) ? matureCohorts.reduce((s, c) => s + c.returned, 0) / matureCohorts.reduce((s, c) => s + c.newCustomers, 0) : null;

  const lcParam = one(sp.lc);
  const lcFilter: Lifecycle[] = lcParam && (LC_ORDER as string[]).includes(lcParam) ? [lcParam as Lifecycle] : ['OVERDUE', 'DORMANT'];
  const candidates = rows.filter((r) => lcFilter.includes(r.lifecycle)).sort((a, b) => b.ltv - a.ltv);
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const pageRows = candidates.slice((page - 1) * PAGE, page * PAGE);
  const pages = Math.max(1, Math.ceil(candidates.length / PAGE));
  const canMessage = ctx.can('message.send');
  const canCustomer = ctx.can('customer.read');

  return (
    <>
      <PageHeader
        title="分析・レポート"
        sub={`${scope.mode === 'shop' ? `${ctx.shop.name}（主担当店舗の顧客）` : '全店舗の顧客'} ・ 累計（LTV）`}
        actions={<ExportLink kind="ltv" sp={sp} label="顧客LTV CSV" enabled={ctx.can('report.export')} />}
      />
      <ReportTabs active="customers" sp={sp} />
      <ReportFilters path="/reports/customers" sp={sp} scope={scope} showPeriod={false} compare={false} />

      {rows.length === 0 ? (
        <Card><Empty title="顧客データがまだありません">会計が登録されると、LTVや来店周期が自動で集計されます。</Empty></Card>
      ) : (
        <>
          <div className="grid-4">
            <Stat label="来店実績のある顧客" value={`${fmtCount(visited.length)}人`} sub={`登録 ${fmtCount(rows.length)}人`} />
            <Stat label="平均LTV（累計売上）" value={yen(avgLtv)} sub={`平均来店 ${visited.length ? (visited.reduce((s, r) => s + r.visitCount, 0) / visited.length).toFixed(1) : '0'}回`} />
            <Stat label="平均来店間隔" value={avgInterval === null ? '—' : `${avgInterval}日`} sub="2回以上来店の顧客" />
            <Stat label="新規再来率（90日）" value={overallRepeat === null ? '—' : fmtPct(overallRepeat)} sub="集計期間が確定した月の平均" />
          </div>

          <Card className="section" title="ライフサイクル">
            <div className="kpi-mini">
              {LC_ORDER.map((k) => (
                <Link key={k} href={`/reports/customers${qs(sp, { lc: k, page: undefined })}#candidates`} aria-label={`${LIFECYCLE_LABEL[k]}の顧客を表示`}>
                  <div><Badge tone={LC_TONE[k]}>{LIFECYCLE_LABEL[k]}</Badge><b>{fmtCount(lc[k])}人</b></div>
                </Link>
              ))}
            </div>
            <p className="sub" style={{ marginTop: 8 }}>来店周期超過＝平均来店間隔（1回のみの方は45日）を超過、フォロー要＝周期の1.5倍を超過、休眠＝最終来店から180日以上。</p>
          </Card>

          <div className="grid-2 section">
            <Card title="LTV分布（顧客数）">
              <ColumnChart ariaLabel="LTV帯別の顧客数" labels={dist.map((d) => d.label)} tableHead="LTV帯"
                series={[{ key: 'count', label: '顧客数', color: SERIES_COLORS[0], values: dist.map((d) => d.count) }]}
                format={(n) => `${fmtCount(n)}人`} axisFormat={(n) => fmtCount(n)} height={230} width={480} />
            </Card>
            <Card title="平均来店間隔の分布">
              {withI.length === 0 ? <Empty title="2回以上来店した顧客がいません" /> : (
                <HBarList ariaLabel="平均来店間隔別の顧客数" rows={intervals.map((d) => ({ key: d.label, label: d.label, value: d.count }))} format={(n) => `${fmtCount(n)}人`} color={SERIES_COLORS[2]} />
              )}
            </Card>
          </div>

          <div className="grid-2 section">
            <Card flush title="セグメント（タグ）別 LTV">
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>タグ</th><th className="num">顧客数</th><th className="num">平均LTV</th><th className="num">平均来店回数</th><th className="num">LTV合計</th></tr></thead>
                  <tbody>
                    {byTag.filter((t) => t.customers > 0 || t.key !== '_untagged').map((t) => (
                      <tr key={t.key} className={t.customers ? '' : 'row-muted'}>
                        <td><span className="row" style={{ gap: 6 }}><i className="dot" style={{ color: t.color }} />{t.label}</span></td>
                        <td className="num">{fmtCount(t.customers)}</td><td className="num">{yen(t.avgLtv)}</td><td className="num">{t.avgVisits}</td><td className="num">{yen(t.totalLtv)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card flush title="初回来店月別の再来率（90日以内）">
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>初回来店月</th><th className="num">新規客</th><th className="num">再来</th><th>再来率</th></tr></thead>
                  <tbody>
                    {cohorts.slice().reverse().map((c) => (
                      <tr key={c.month} className={c.newCustomers ? '' : 'row-muted'}>
                        <td>{c.month.replace('-', '年')}月 {!c.mature && c.newCustomers > 0 && <Badge tone="amber">集計中</Badge>}</td>
                        <td className="num">{fmtCount(c.newCustomers)}</td>
                        <td className="num">{fmtCount(c.returned)}</td>
                        <td style={{ minWidth: 140 }}>
                          {c.newCustomers ? <div className="row"><div className="bar" style={{ flex: 1 }}><span style={{ width: `${Math.max(1, c.rate * 100)}%` }} /></div><span className="num" style={{ width: 52, textAlign: 'right' }}>{fmtPct(c.rate, 0)}</span></div> : <span className="sub">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>

          <Card className="section" flush title={<h2 id="candidates">{lcParam ? `${LIFECYCLE_LABEL[lcFilter[0]]}の顧客` : '休眠・フォロー候補'}（{fmtCount(candidates.length)}人）</h2>}
            actions={lcParam ? <Link className="btn ghost sm" href={`/reports/customers${qs(sp, { lc: undefined, page: undefined })}#candidates`}>休眠・フォロー候補に戻す</Link> : undefined}>
            {candidates.length === 0 ? <Empty title="該当する顧客はいません" /> : (
              <>
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>顧客</th><th>状態</th><th className="num">LTV</th><th className="num">来店回数</th><th className="num">平均間隔</th><th>最終来店</th><th>担当</th><th /></tr></thead>
                    <tbody>
                      {pageRows.map((r) => (
                        <tr key={r.id}>
                          <td>{canCustomer ? <Link className="link" href={`/customers/${r.id}`}>{r.name}</Link> : r.name}</td>
                          <td><Badge tone={LC_TONE[r.lifecycle]}>{LIFECYCLE_LABEL[r.lifecycle]}</Badge></td>
                          <td className="num">{yen(r.ltv)}</td>
                          <td className="num">{r.visitCount}回</td>
                          <td className="num">{r.avgIntervalDays === null ? '—' : `${Math.round(r.avgIntervalDays)}日`}</td>
                          <td>{fmtDate(r.lastVisitAt)}{r.daysSince !== null && <div className="sub">{r.daysSince}日前</div>}</td>
                          <td>{r.assignedStaffId ? staffName.get(r.assignedStaffId) ?? '—' : '—'}</td>
                          <td className="right">{canMessage && <Link className="btn secondary sm" href={`/messages?customerId=${r.id}`}>メッセージ</Link>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {pages > 1 && (
                  <div className="between" style={{ padding: '10px 16px' }}>
                    <span className="sub">{page} / {pages} ページ</span>
                    <div className="row">
                      {page > 1 && <Link className="btn secondary sm" href={`/reports/customers${qs(sp, { page: String(page - 1) })}#candidates`}>前へ</Link>}
                      {page < pages && <Link className="btn secondary sm" href={`/reports/customers${qs(sp, { page: String(page + 1) })}#candidates`}>次へ</Link>}
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>
        </>
      )}
    </>
  );
}
