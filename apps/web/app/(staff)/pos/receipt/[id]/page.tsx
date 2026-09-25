import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { actorOf, getTicket } from '@/lib/server/pos';
import { pointsBalance } from '@/lib/server/customers';
import { PageHeader } from '@/components/ui';
import { fmtDateTime, yen } from '@/lib/format';
import { cashTendered, METHOD_LABEL, paymentLabel, type PaymentMethodName } from '@/lib/pos-shared';
import { PrintButton } from '../../_components/PrintButton';

export const metadata = { title: 'レシート' };

export default async function ReceiptPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string }> }) {
  const ctx = await requirePage('pos.checkout');
  const { id } = await params;
  const { done } = await searchParams;
  const t = await getTicket(actorOf(ctx), id).catch(() => null);
  if (!t) notFound();
  if (t.status === 'DRAFT') redirect(`/pos/checkout?transactionId=${t.id}`);
  const tz = t.shop.timezone;
  const staffIds = [...new Set([t.staffId, ...t.items.map((i) => i.staffId)].filter(Boolean) as string[])];
  const [members, balance] = await Promise.all([
    staffIds.length ? prisma.membership.findMany({ where: { organizationId: ctx.org.id, userId: { in: staffIds } }, select: { userId: true, displayName: true } }) : [],
    t.customerId ? pointsBalance(t.customerId) : Promise.resolve(null),
  ]);
  const staffName = t.staffId ? members.find((m) => m.userId === t.staffId)?.displayName : null;
  const cash = t.payments.filter((p) => p.method === 'CASH');
  const tendered = cash.reduce((a, p) => a + cashTendered(p), 0);
  const cashApplied = cash.reduce((a, p) => a + p.amount, 0);
  const change = tendered - cashApplied;

  return (
    <>
      <div className="no-print">
        <PageHeader
          title={`レシート No.${t.number}`}
          back={{ href: '/pos', label: 'POS' }}
          actions={<>
            <PrintButton label="レシートを印刷" />
            <Link className="btn secondary" href={`/pos/transactions/${t.id}`}>取引詳細</Link>
            <Link className="btn" href="/pos/checkout">次の会計</Link>
          </>}
        />
        {done && (
          <div className="alert success" style={{ marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
            <CheckCircle2 size={20} />
            <div><strong>会計が完了しました。</strong>{change > 0 && <> お釣り <strong style={{ fontSize: 18 }}>{yen(change)}</strong> をお渡しください。</>}</div>
          </div>
        )}
      </div>

      <div className="receipt" aria-label="レシート">
        <h2>{t.shop.name}</h2>
        {t.shop.address && <div className="r-center">{t.shop.address}</div>}
        {t.shop.phone && <div className="r-center">TEL {t.shop.phone}</div>}
        <div className="r-rule" />
        <div className="r-center" style={{ fontWeight: 800, fontSize: 14 }}>{t.status === 'VOID' ? '【取消】' : '領 収 書'}</div>
        <div className="r-row"><span>No.{t.number}</span><span>{fmtDateTime(t.paidAt ?? t.createdAt, tz)}</span></div>
        {t.customer && <div>{t.customer.lastName} {t.customer.firstName} 様</div>}
        {staffName && <div>担当: {staffName}</div>}
        <div className="r-rule" />
        {t.items.map((i) => (
          <div key={i.id}>
            <div className="r-row"><span>{i.name}</span><span>{yen(i.unitPrice * i.quantity)}</span></div>
            {i.quantity > 1 && <div className="r-sub">{yen(i.unitPrice)} × {i.quantity}</div>}
            {i.discount > 0 && <div className="r-row r-sub"><span>値引き</span><span>−{yen(i.discount)}</span></div>}
          </div>
        ))}
        <div className="r-rule" />
        <div className="r-row"><span>小計</span><span>{yen(t.subtotal - t.lineDiscounts)}</span></div>
        {t.couponDiscount > 0 && <div className="r-row"><span>クーポン{t.coupon ? `（${t.coupon.name}）` : ''}</span><span>−{yen(t.couponDiscount)}</span></div>}
        {t.manualDiscount > 0 && <div className="r-row"><span>割引</span><span>−{yen(t.manualDiscount)}</span></div>}
        {t.pointsUsed > 0 && <div className="r-row"><span>ポイント利用</span><span>−{yen(t.pointsUsed)}</span></div>}
        <div className="r-row r-total"><span>合計</span><span>{yen(t.total)}</span></div>
        <div className="r-row r-sub"><span>（内消費税等 {t.shop.taxRatePct}%）</span><span>{yen(t.taxTotal)}</span></div>
        <div className="r-rule" />
        {t.payments.filter((p) => p.method !== 'CASH').map((p) => (
          <div key={p.id} className="r-row"><span>{paymentLabel(p)}</span><span>{yen(p.amount)}</span></div>
        ))}
        {cash.length > 0 && <>
          <div className="r-row"><span>{METHOD_LABEL.CASH} お預り</span><span>{yen(tendered)}</span></div>
          <div className="r-row"><span>お釣り</span><span>{yen(change)}</span></div>
        </>}
        {t.payments.length === 0 && t.total === 0 && <div className="r-row"><span>お支払い</span><span>{yen(0)}</span></div>}
        {t.refunds.length > 0 && <>
          <div className="r-rule" />
          {t.refunds.map((r) => <div key={r.id} className="r-row"><span>返金（{METHOD_LABEL[r.method as PaymentMethodName]}）</span><span>−{yen(r.amount)}</span></div>)}
        </>}
        {t.customerId && <>
          <div className="r-rule" />
          <div className="r-row"><span>今回付与ポイント</span><span>{t.pointsEarned.toLocaleString()}pt</span></div>
          {balance !== null && <div className="r-row"><span>ポイント残高</span><span>{balance.toLocaleString()}pt</span></div>}
        </>}
        <div className="r-rule" />
        <div className="r-center">ご来店ありがとうございました</div>
      </div>
    </>
  );
}
