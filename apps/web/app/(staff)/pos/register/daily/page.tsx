import Link from 'next/link';
import { addDays, isDateStr, todayIn } from '@salonos/core';
import { requirePage } from '@/lib/server/session';
import { actorOf, dailyReport } from '@/lib/server/pos';
import { Card, Empty, PageHeader, Stat } from '@/components/ui';
import { fmtDateTime, fmtTime, yen } from '@/lib/format';
import { METHOD_LABEL, type PaymentMethodName } from '@/lib/pos-shared';
import { PosTabs } from '../../_components/PosTabs';
import { PrintButton } from '../../_components/PrintButton';

export const metadata = { title: '日次レポート' };

export default async function DailyReportPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const ctx = await requirePage('pos.register');
  const { date: raw } = await searchParams;
  const today = todayIn(ctx.shop.timezone);
  const date = raw && isDateStr(raw) ? raw : today;
  const r = await dailyReport(actorOf(ctx), ctx.shop.id, date);
  const tz = ctx.shop.timezone;
  const methods = Object.keys({ ...r.byMethod, ...r.refundsByMethod }) as PaymentMethodName[];

  return (
    <>
      <PageHeader
        title="日次レポート"
        sub={`${r.shop.name} ・ ${date.replaceAll('-', '/')}`}
        actions={<div className="toolbar no-print">
          <Link className="btn secondary sm" href={`/pos/register/daily?date=${addDays(date, -1)}`}>← 前日</Link>
          <form action="/pos/register/daily" className="row" style={{ gap: 6 }}><input type="date" name="date" className="input sm" defaultValue={date} aria-label="日付" /><button className="btn secondary sm">表示</button></form>
          {date < today && <Link className="btn secondary sm" href={`/pos/register/daily?date=${addDays(date, 1)}`}>翌日 →</Link>}
          <PrintButton />
        </div>}
      />
      <PosTabs active="daily" canRegister />
      {r.openDrafts > 0 && date === today && <div className="alert warn no-print" style={{ marginBottom: 14 }}>未確定の下書きが {r.openDrafts}件 あります。<Link className="link" href="/pos">POSで確認</Link></div>}

      <div className="grid-4">
        <Stat label="純売上" value={yen(r.net)} sub={`総売上 ${yen(r.gross)} − 返金 ${yen(r.refundTotal)}`} />
        <Stat label="会計件数" value={`${r.txCount}件`} sub={`客数 ${r.customerCount}人`} />
        <Stat label="客単価" value={yen(r.avgTicket)} />
        <Stat label="施術 / 店販" value={yen(r.serviceTotal)} sub={`店販 ${yen(r.retailTotal)}`} />
      </div>

      {r.txCount === 0 && r.refunds.length === 0 ? (
        <Card className="section"><Empty title="この日の会計はありません" /></Card>
      ) : (
        <div className="split section">
          <div className="stack">
            <Card title="支払方法別" flush>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>支払方法</th><th className="num">売上</th><th className="num">返金</th><th className="num">差引</th></tr></thead>
                  <tbody>
                    {methods.map((m) => <tr key={m}><td>{METHOD_LABEL[m] ?? m}</td><td className="num">{yen(r.byMethod[m] ?? 0)}</td><td className="num">{r.refundsByMethod[m] ? `−${yen(r.refundsByMethod[m])}` : ''}</td><td className="num">{yen((r.byMethod[m] ?? 0) - (r.refundsByMethod[m] ?? 0))}</td></tr>)}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card title="スタッフ別" flush>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>スタッフ</th><th className="num">件数</th><th className="num">指名</th><th className="num">施術</th><th className="num">店販</th><th className="num">合計</th></tr></thead>
                  <tbody>
                    {r.byStaff.map((s) => <tr key={s.staffId}><td>{s.name}</td><td className="num">{s.count}</td><td className="num">{s.nominated}</td><td className="num">{yen(s.service)}</td><td className="num">{yen(s.retail)}</td><td className="num">{yen(s.sales)}</td></tr>)}
                  </tbody>
                </table>
              </div>
            </Card>
            {r.refunds.length > 0 && (
              <Card title="返金" flush>
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>時刻</th><th>No.</th><th>方法</th><th>理由</th><th className="num">金額</th></tr></thead>
                    <tbody>{r.refunds.map((x) => <tr key={x.id}><td>{fmtTime(x.createdAt, tz)}</td><td className="mono">{x.number}</td><td>{METHOD_LABEL[x.method as PaymentMethodName]}</td><td>{x.reason ?? '—'}</td><td className="num">−{yen(x.amount)}</td></tr>)}</tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>
          <div className="stack">
            <Card title="集計">
              <dl className="kv">
                <dt>総売上（税込）</dt><dd className="num">{yen(r.gross)}</dd>
                <dt>うち消費税</dt><dd className="num">{yen(r.taxTotal)}</dd>
                <dt>値引き合計</dt><dd className="num">{yen(r.discountTotal)}</dd>
                <dt>ポイント利用</dt><dd className="num">{r.pointsUsed.toLocaleString()}pt</dd>
                <dt>ポイント付与</dt><dd className="num">{r.pointsEarned.toLocaleString()}pt</dd>
                <dt>取消</dt><dd>{r.voids.length}件{r.voids.length ? `（${r.voids.map((v) => `No.${v.number}`).join('、')}）` : ''}</dd>
              </dl>
            </Card>
            <Card title="レジ">
              {r.sessions.length === 0 ? <div className="sub">この日のレジ開局記録はありません</div> : (
                <div className="list">
                  {r.sessions.map((s) => (
                    <div key={s.id} className="list-item">
                      <div className="grow">
                        <div>{fmtTime(s.openedAt, tz)} 〜 {s.closedAt ? fmtTime(s.closedAt, tz) : '営業中'}</div>
                        <div className="sub">準備金 {yen(s.openingCash)}{s.closedAt ? ` ・ 理論 ${yen(s.expectedCash ?? 0)} ・ 実際 ${yen(s.actualCash ?? 0)}` : ''}</div>
                      </div>
                      {s.difference !== null && <strong className={s.difference === 0 ? '' : s.difference > 0 ? 'diff-plus' : 'diff-minus'}>{s.difference > 0 ? '+' : ''}{yen(s.difference)}</strong>}
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <div className="sub">出力日時 {fmtDateTime(new Date(), tz)}</div>
          </div>
        </div>
      )}
    </>
  );
}
