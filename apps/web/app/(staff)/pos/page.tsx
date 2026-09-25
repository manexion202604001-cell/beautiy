import Link from 'next/link';
import { Plus, Search, UserRound, Wallet } from 'lucide-react';
import { addDays, localToUtc, todayIn } from '@salonos/core';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { currentRegister, searchPosCustomers } from '@/lib/server/pos';
import { METHOD_LABEL, type PaymentMethodName } from '@/lib/pos-shared';
import { STATUS_LABEL } from '@/lib/server/booking';
import { Badge, Card, Empty, PageHeader, Stat } from '@/components/ui';
import { fmtDateTime, fmtRange, fmtTime, yen } from '@/lib/format';
import { PosTabs } from './_components/PosTabs';
import { TxStatusBadge } from './_components/TxStatusBadge';

export const metadata = { title: 'POS・会計' };

const IN_STORE = ['ARRIVED', 'IN_SERVICE', 'COMPLETED'];

export default async function PosHome({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const ctx = await requirePage('pos.checkout');
  const { q } = await searchParams;
  const shop = ctx.shop;
  const today = todayIn(shop.timezone);
  const from = localToUtc(today, 0, shop.timezone), to = localToUtc(addDays(today, 1), 0, shop.timezone);

  const [register, appts, drafts, paid, found] = await Promise.all([
    currentRegister(shop.id),
    prisma.appointment.findMany({
      where: { shopId: shop.id, startAt: { gte: from, lt: to }, status: { notIn: ['CANCELLED', 'NO_SHOW'] }, kind: { not: 'PRIVATE' } },
      include: { customer: { select: { id: true, lastName: true, firstName: true } }, menus: { select: { name: true, price: true } }, transaction: { select: { id: true, status: true } } },
      orderBy: { startAt: 'asc' },
    }),
    prisma.transaction.findMany({
      where: { shopId: shop.id, status: 'DRAFT' },
      include: { customer: { select: { lastName: true, firstName: true } }, _count: { select: { items: true } } },
      orderBy: { updatedAt: 'desc' }, take: 20,
    }),
    prisma.transaction.findMany({
      where: { shopId: shop.id, paidAt: { gte: from, lt: to }, status: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
      include: { customer: { select: { lastName: true, firstName: true } }, payments: { select: { method: true } } },
      orderBy: { paidAt: 'desc' },
    }),
    q && ctx.can('customer.read') ? searchPosCustomers(ctx.org.id, q) : Promise.resolve(null),
  ]);

  const staffIds = [...new Set(appts.map((a) => a.staffId).filter(Boolean) as string[])];
  const members = staffIds.length ? await prisma.membership.findMany({ where: { organizationId: ctx.org.id, userId: { in: staffIds } }, select: { userId: true, displayName: true } }) : [];
  const staffName = new Map(members.map((m) => [m.userId, m.displayName]));

  const unpaid = appts
    .filter((a) => !a.transaction || a.transaction.status === 'DRAFT')
    .sort((a, b) => Number(!IN_STORE.includes(a.status)) - Number(!IN_STORE.includes(b.status)) || a.startAt.getTime() - b.startAt.getTime());
  const sales = paid.reduce((s, t) => s + t.total - t.refundedTotal, 0);

  return (
    <>
      <PageHeader
        title="POS・会計"
        sub={`${shop.name} ・ ${today.replaceAll('-', '/')}`}
        actions={<Link href="/pos/checkout" className="btn"><Plus size={16} />新規会計（飛び込み）</Link>}
      />
      <PosTabs active="home" canRegister={ctx.can('pos.register')} />

      <div className="grid-4">
        <Stat label="本日の売上（返金控除後）" value={yen(sales)} sub={`${paid.length}件の会計`} />
        <Stat label="未会計の予約" value={`${unpaid.length}件`} sub={`来店中 ${unpaid.filter((a) => IN_STORE.includes(a.status)).length}件`} />
        <Stat label="下書き" value={`${drafts.length}件`} />
        <div className="card stat">
          <div className="label">レジ</div>
          <div className="value" style={{ fontSize: 20 }}>{register ? <Badge tone="green">営業中</Badge> : <Badge tone="amber">未開局</Badge>}</div>
          <div className="sub" style={{ marginTop: 6 }}>
            {register ? `${fmtTime(register.openedAt, shop.timezone)} 開局・準備金 ${yen(register.openingCash)}` : '現金会計の前にレジを開けてください'}
            {ctx.can('pos.register') && <> ・ <Link className="link" href="/pos/register">{register ? 'レジ締め' : 'レジ開け'}</Link></>}
          </div>
        </div>
      </div>

      <div className="split section">
        <Card title="本日の予約（未会計）" flush>
          {unpaid.length === 0 ? (
            <Empty title="未会計の予約はありません" icon={<Wallet size={20} />}>本日の予約はすべて会計済みです。</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>時間</th><th>お客様</th><th>メニュー</th><th>担当</th><th>状態</th><th className="num">予定額</th><th /></tr></thead>
                <tbody>
                  {unpaid.map((a) => (
                    <tr key={a.id}>
                      <td className="nowrap">{fmtRange(a.startAt, a.endAt, shop.timezone)}</td>
                      <td>{a.customer ? `${a.customer.lastName} ${a.customer.firstName}` : a.guestName ?? 'ゲスト'}</td>
                      <td className="sub">{a.menus.map((m) => m.name).join('、') || a.title || '—'}</td>
                      <td>{a.staffId ? staffName.get(a.staffId) ?? '—' : 'フリー'}</td>
                      <td><Badge tone={IN_STORE.includes(a.status) ? 'green' : 'blue'}>{STATUS_LABEL[a.status]}</Badge>{a.transaction && <> <Badge tone="violet">下書き</Badge></>}</td>
                      <td className="num">{yen(a.totalPrice)}</td>
                      <td className="right"><Link className="btn sm" href={`/pos/checkout?appointmentId=${a.id}`}>会計を開始</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="stack">
          <Card title="お客様を検索して会計">
            <form className="row" action="/pos">
              <input className="input" name="q" defaultValue={q ?? ''} placeholder="氏名・カナ・電話番号" aria-label="顧客検索" />
              <button className="btn secondary"><Search size={16} />検索</button>
            </form>
            {found && (
              <div className="list" style={{ marginTop: 8 }}>
                {found.length === 0 && <div className="sub" style={{ padding: '10px 0' }}>該当するお客様が見つかりません</div>}
                {found.map((c) => (
                  <div key={c.id} className="list-item">
                    <UserRound size={18} className="muted" />
                    <div className="grow">
                      <div style={{ fontWeight: 700 }}>{c.lastName} {c.firstName}</div>
                      <div className="sub">{[c.lastNameKana, c.firstNameKana].filter(Boolean).join(' ')} ・ 来店{c.visitCount}回 ・ {c.points.toLocaleString()}pt</div>
                    </div>
                    <Link className="btn sm" href={`/pos/checkout?customerId=${c.id}`}>会計</Link>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="下書き" flush>
            {drafts.length === 0 ? <Empty title="下書きはありません" /> : (
              <div className="list" style={{ padding: '0 18px' }}>
                {drafts.map((t) => (
                  <div key={t.id} className="list-item">
                    <div className="grow">
                      <div style={{ fontWeight: 700 }}>No.{t.number} {t.customer ? `${t.customer.lastName} ${t.customer.firstName}` : 'ゲスト'}</div>
                      <div className="sub">{t._count.items}点 ・ {yen(t.total)} ・ {fmtDateTime(t.updatedAt, shop.timezone)}</div>
                    </div>
                    <Link className="btn sm secondary" href={`/pos/checkout?transactionId=${t.id}`}>再開</Link>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <Card title="本日の会計" className="section" flush actions={<Link className="btn sm ghost" href="/pos/transactions">すべて見る</Link>}>
        {paid.length === 0 ? <Empty title="本日の会計はまだありません" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>No.</th><th>時刻</th><th>お客様</th><th>支払方法</th><th>状態</th><th className="num">合計</th><th /></tr></thead>
              <tbody>
                {paid.map((t) => (
                  <tr key={t.id}>
                    <td className="mono">{t.number}</td>
                    <td>{t.paidAt ? fmtTime(t.paidAt, shop.timezone) : '—'}</td>
                    <td>{t.customer ? `${t.customer.lastName} ${t.customer.firstName}` : 'ゲスト'}</td>
                    <td className="sub">{[...new Set(t.payments.map((p) => p.method))].map((m) => METHOD_LABEL[m as PaymentMethodName]).join('・') || 'ポイント'}</td>
                    <td><TxStatusBadge status={t.status} /></td>
                    <td className="num">{yen(t.total)}</td>
                    <td className="right"><Link className="btn sm ghost" href={`/pos/receipt/${t.id}`}>レシート</Link> <Link className="btn sm ghost" href={`/pos/transactions/${t.id}`}>詳細</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
