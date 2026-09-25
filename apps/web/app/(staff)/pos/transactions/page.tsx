import Link from 'next/link';
import type { Prisma } from '@salonos/db';
import { addDays, isDateStr, localToUtc, todayIn } from '@salonos/core';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { Card, Empty, PageHeader, Stat } from '@/components/ui';
import { fmtDateTime, yen } from '@/lib/format';
import { METHOD_LABEL, PAYMENT_METHODS, TX_STATUSES, TX_STATUS_LABEL, type PaymentMethodName } from '@/lib/pos-shared';
import { PosTabs } from '../_components/PosTabs';
import { TxStatusBadge } from '../_components/TxStatusBadge';

export const metadata = { title: '取引履歴' };

const PAGE = 50;
type SP = { from?: string; to?: string; status?: string; method?: string; staff?: string; page?: string };

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePage('pos.checkout');
  const sp = await searchParams;
  const shop = ctx.shop;
  const today = todayIn(shop.timezone);
  const from = sp.from && isDateStr(sp.from) ? sp.from : addDays(today, -6);
  const to = sp.to && isDateStr(sp.to) && sp.to >= from ? sp.to : today;
  const status = TX_STATUSES.includes(sp.status as any) ? sp.status as (typeof TX_STATUSES)[number] : undefined;
  const method = PAYMENT_METHODS.includes(sp.method as any) ? sp.method as PaymentMethodName : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const start = localToUtc(from, 0, shop.timezone), end = localToUtc(addDays(to, 1), 0, shop.timezone);

  const staff = await prisma.staffAssignment.findMany({ where: { shopId: shop.id }, include: { membership: { select: { userId: true, displayName: true } } } });
  const staffId = staff.some((s) => s.membership.userId === sp.staff) ? sp.staff : undefined;

  const where: Prisma.TransactionWhereInput = {
    shopId: shop.id, organizationId: ctx.org.id,
    OR: [{ paidAt: { gte: start, lt: end } }, { paidAt: null, createdAt: { gte: start, lt: end } }],
    ...(status ? { status } : {}),
    ...(method ? { payments: { some: { method } } } : {}),
    ...(staffId ? { AND: [{ OR: [{ staffId }, { items: { some: { staffId } } }] }] } : {}),
  };
  const [rows, count, sums] = await Promise.all([
    prisma.transaction.findMany({
      where, orderBy: [{ paidAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }], skip: (page - 1) * PAGE, take: PAGE,
      include: { customer: { select: { lastName: true, firstName: true } }, payments: { select: { method: true } } },
    }),
    prisma.transaction.count({ where }),
    prisma.transaction.aggregate({ where: { ...where, status: { in: status ? [status] : ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] } }, _sum: { total: true, refundedTotal: true, taxTotal: true }, _count: true }),
  ]);
  const names = new Map(staff.map((s) => [s.membership.userId, s.membership.displayName]));
  const gross = sums._sum.total ?? 0, refunded = sums._sum.refundedTotal ?? 0;
  const pages = Math.max(1, Math.ceil(count / PAGE));
  const qs = (p: number) => new URLSearchParams(Object.entries({ from, to, status: status ?? '', method: method ?? '', staff: staffId ?? '', page: String(p) }).filter(([, v]) => v)).toString();

  return (
    <>
      <PageHeader title="取引履歴" sub={`${shop.name} ・ ${from.replaceAll('-', '/')}〜${to.replaceAll('-', '/')}`} />
      <PosTabs active="transactions" canRegister={ctx.can('pos.register')} />

      <form className="card" style={{ marginBottom: 14 }} action="/pos/transactions">
        <div className="row-wrap" style={{ alignItems: 'flex-end', gap: 10 }}>
          <div className="field"><label htmlFor="from">開始日</label><input id="from" className="input" type="date" name="from" defaultValue={from} /></div>
          <div className="field"><label htmlFor="to">終了日</label><input id="to" className="input" type="date" name="to" defaultValue={to} /></div>
          <div className="field"><label htmlFor="status">状態</label>
            <select id="status" name="status" className="select" defaultValue={status ?? ''}>
              <option value="">すべて</option>
              {TX_STATUSES.map((s) => <option key={s} value={s}>{TX_STATUS_LABEL[s]}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="method">支払方法</label>
            <select id="method" name="method" className="select" defaultValue={method ?? ''}>
              <option value="">すべて</option>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="staff">担当</label>
            <select id="staff" name="staff" className="select" defaultValue={staffId ?? ''}>
              <option value="">すべて</option>
              {staff.map((s) => <option key={s.membership.userId} value={s.membership.userId}>{s.membership.displayName}</option>)}
            </select>
          </div>
          <button className="btn">絞り込む</button>
          <Link className="btn ghost" href="/pos/transactions">リセット</Link>
        </div>
      </form>

      <div className="grid-4" style={{ marginBottom: 14 }}>
        <Stat label="売上（税込）" value={yen(gross)} sub={`${sums._count}件`} />
        <Stat label="返金" value={yen(refunded)} />
        <Stat label="純売上" value={yen(gross - refunded)} />
        <Stat label="うち消費税" value={yen(sums._sum.taxTotal ?? 0)} />
      </div>

      <Card flush>
        {rows.length === 0 ? <Empty title="該当する取引はありません">条件を変更して再度検索してください。</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>No.</th><th>日時</th><th>お客様</th><th>担当</th><th>支払方法</th><th>状態</th><th className="num">合計</th><th className="num">返金</th><th /></tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td className="mono">{t.number}</td>
                    <td className="nowrap">{fmtDateTime(t.paidAt ?? t.createdAt, shop.timezone)}</td>
                    <td>{t.customer ? `${t.customer.lastName} ${t.customer.firstName}` : 'ゲスト'}</td>
                    <td>{t.staffId ? names.get(t.staffId) ?? '—' : '—'}</td>
                    <td className="sub">{[...new Set(t.payments.map((p) => p.method))].map((m) => METHOD_LABEL[m as PaymentMethodName]).join('・') || '—'}</td>
                    <td><TxStatusBadge status={t.status} /></td>
                    <td className="num">{yen(t.total)}</td>
                    <td className="num">{t.refundedTotal ? `−${yen(t.refundedTotal)}` : ''}</td>
                    <td className="right nowrap">
                      {t.status === 'DRAFT'
                        ? <Link className="btn sm secondary" href={`/pos/checkout?transactionId=${t.id}`}>再開</Link>
                        : <Link className="btn sm ghost" href={`/pos/transactions/${t.id}`}>詳細</Link>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {pages > 1 && (
        <div className="between section">
          <span className="sub">{count}件中 {(page - 1) * PAGE + 1}〜{Math.min(count, page * PAGE)}件</span>
          <div className="toolbar">
            {page > 1 && <Link className="btn secondary sm" href={`/pos/transactions?${qs(page - 1)}`}>前へ</Link>}
            <span className="sub">{page} / {pages}</span>
            {page < pages && <Link className="btn secondary sm" href={`/pos/transactions?${qs(page + 1)}`}>次へ</Link>}
          </div>
        </div>
      )}
    </>
  );
}
