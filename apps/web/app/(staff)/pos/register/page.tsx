import Link from 'next/link';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { currentRegister, registerSummary, type RegisterSummary } from '@/lib/server/pos';
import { Badge, Card, Empty, PageHeader, Stat } from '@/components/ui';
import { fmtDateTime, fmtTime, yen } from '@/lib/format';
import { METHOD_LABEL, type PaymentMethodName } from '@/lib/pos-shared';
import { PosTabs } from '../_components/PosTabs';
import { CloseRegisterForm, OpenRegisterForm } from './RegisterForms';

export const metadata = { title: 'レジ開け・締め' };

function Diff({ n }: { n: number | null }) {
  if (n === null) return <>—</>;
  return <span className={n === 0 ? '' : n > 0 ? 'diff-plus' : 'diff-minus'}>{n > 0 ? '+' : ''}{yen(n)}</span>;
}

function MethodTable({ s }: { s: RegisterSummary }) {
  const methods = Object.keys({ ...s.byMethod, ...s.refundsByMethod }) as PaymentMethodName[];
  if (!methods.length) return <div className="sub">売上はまだありません</div>;
  return (
    <table className="table">
      <thead><tr><th>支払方法</th><th className="num">売上</th><th className="num">返金</th></tr></thead>
      <tbody>{methods.map((m) => <tr key={m}><td>{METHOD_LABEL[m] ?? m}</td><td className="num">{yen(s.byMethod[m] ?? 0)}</td><td className="num">{s.refundsByMethod[m] ? `−${yen(s.refundsByMethod[m])}` : ''}</td></tr>)}</tbody>
    </table>
  );
}

export default async function RegisterPage() {
  const ctx = await requirePage('pos.register');
  const shop = ctx.shop;
  const [open, history] = await Promise.all([
    currentRegister(shop.id),
    prisma.registerSession.findMany({ where: { shopId: shop.id, closedAt: { not: null } }, orderBy: { openedAt: 'desc' }, take: 30 }),
  ]);
  const summary = open ? await registerSummary(prisma, open.id) : null;
  const userIds = [...new Set([open?.openedById, ...history.flatMap((h) => [h.openedById, h.closedById])].filter(Boolean) as string[])];
  const members = userIds.length ? await prisma.membership.findMany({ where: { organizationId: ctx.org.id, userId: { in: userIds } }, select: { userId: true, displayName: true } }) : [];
  const name = (id: string | null | undefined) => members.find((m) => m.userId === id)?.displayName ?? '—';

  return (
    <>
      <PageHeader title="レジ開け・締め" sub={shop.name} actions={<Link className="btn secondary" href="/pos/register/daily">日次レポート</Link>} />
      <PosTabs active="register" canRegister />

      {open && summary ? (
        <div className="split">
          <div className="stack">
            <div className="grid-2">
              <Stat label="理論現金（ドロワー）" value={yen(summary.expectedCash)} sub={`準備金 ${yen(summary.openingCash)} ＋ 現金売上 ${yen(summary.cashSales)} − 現金返金 ${yen(summary.cashRefunds)}`} />
              <Stat label="売上合計" value={yen(summary.salesTotal)} sub={`${summary.txCount}件 ・ 客数 ${summary.customerCount}人`} />
            </div>
            <Card title="支払方法別" flush><div className="table-wrap"><MethodTable s={summary} /></div></Card>
            <Card title="内訳">
              <dl className="kv">
                <dt>施術売上</dt><dd className="num">{yen(summary.serviceTotal)}</dd>
                <dt>店販売上</dt><dd className="num">{yen(summary.retailTotal)}</dd>
                <dt>値引き合計</dt><dd className="num">{yen(summary.discountTotal)}</dd>
                <dt>ポイント利用</dt><dd className="num">{summary.pointsUsed.toLocaleString()}pt</dd>
                <dt>返金</dt><dd className="num">{summary.refundCount}件 {yen(summary.refundTotal)}</dd>
                <dt>取消</dt><dd>{summary.voidCount}件</dd>
              </dl>
            </Card>
          </div>
          <Card title={<div className="row"><h2>レジ締め</h2><Badge tone="green">営業中</Badge></div>}>
            <div className="sub" style={{ marginBottom: 12 }}>{fmtDateTime(open.openedAt, shop.timezone)} に {name(open.openedById)} が開局</div>
            <CloseRegisterForm sessionId={open.id} expected={summary.expectedCash} />
          </Card>
        </div>
      ) : (
        <Card title={<div className="row"><h2>レジ開け</h2><Badge tone="amber">未開局</Badge></div>}>
          <OpenRegisterForm shopId={shop.id} suggested={history[0]?.actualCash ?? 30000} />
        </Card>
      )}

      <Card title="過去のレジ締め" className="section" flush>
        {history.length === 0 ? <Empty title="レジ締めの記録はまだありません" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>営業</th><th>開局 / 締め</th><th className="num">準備金</th><th className="num">売上</th><th className="num">理論現金</th><th className="num">実際</th><th className="num">差額</th><th>メモ</th></tr></thead>
              <tbody>
                {history.map((h) => {
                  const s = h.summary as unknown as RegisterSummary | null;
                  return (
                    <tr key={h.id}>
                      <td className="nowrap">{fmtDateTime(h.openedAt, shop.timezone).slice(0, 10)}</td>
                      <td className="sub nowrap">{fmtTime(h.openedAt, shop.timezone)} {name(h.openedById)} → {h.closedAt ? fmtTime(h.closedAt, shop.timezone) : ''} {name(h.closedById)}</td>
                      <td className="num">{yen(h.openingCash)}</td>
                      <td className="num">{s ? yen(s.salesTotal) : '—'}</td>
                      <td className="num">{yen(h.expectedCash ?? 0)}</td>
                      <td className="num">{yen(h.actualCash ?? 0)}</td>
                      <td className="num"><Diff n={h.difference} /></td>
                      <td className="sub">{h.note ?? ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
