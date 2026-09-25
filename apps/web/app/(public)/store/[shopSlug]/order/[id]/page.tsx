import Link from 'next/link';
import { CheckCircle2, Clock, Package, Repeat } from 'lucide-react';
import { prisma } from '@/lib/server/db';
import { storeShop, verifyOrderToken } from '@/lib/server/commerce';
import { Empty } from '@/components/ui';
import { fmtDate, fmtDateTime, yen } from '@/lib/format';
import { ORDER_STATUS_LABEL } from '@/lib/pos-shared';
import { AutoRefresh } from './AutoRefresh';

export const metadata = { title: 'ご注文内容', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function OrderPage({ params, searchParams }: { params: Promise<{ shopSlug: string; id: string }>; searchParams: Promise<{ t?: string; paid?: string }> }) {
  const { shopSlug, id } = await params;
  const { t, paid } = await searchParams;
  const shop = await storeShop(shopSlug);
  const order = shop && verifyOrderToken(id, t) ? await prisma.order.findFirst({ where: { id, shopId: shop.id }, include: { items: true } }) : null;
  if (!shop || !order) {
    return <div className="card"><Empty title="ご注文が見つかりません">URLが正しいかご確認ください。</Empty></div>;
  }
  const subs = order.isSubscription ? await prisma.subscription.findMany({ where: { orderId: order.id }, orderBy: { nextShipAt: 'asc' } }) : [];
  // Never trust the ?paid=1 redirect: status only changes via verified provider webhooks.
  const awaitingWebhook = order.status === 'PENDING' && paid === '1' && order.paymentProvider === 'STRIPE';
  const inStore = order.paymentProvider === 'IN_STORE';
  return (
    <div className="stack">
      <div className="card center" style={{ padding: 24 }}>
        {order.status === 'PENDING' && awaitingWebhook ? <Clock size={40} color="var(--amber)" /> : <CheckCircle2 size={40} color="var(--green)" />}
        <h1 style={{ fontSize: 20, marginTop: 8 }}>
          {awaitingWebhook ? 'お支払いを確認しています…' : order.status === 'PENDING' ? 'ご注文を受け付けました' : order.status === 'CANCELLED' ? 'ご注文はキャンセルされました' : order.status === 'REFUNDED' ? 'ご注文は返金済みです' : 'ご注文ありがとうございます'}
        </h1>
        <div className="sub" style={{ marginTop: 4 }}>注文番号 #{order.number} ・ {fmtDateTime(order.createdAt)} ・ {ORDER_STATUS_LABEL[order.status]}</div>
        {awaitingWebhook && <><div className="sub" style={{ marginTop: 8 }}>決済会社からの通知を待っています。このページは自動で更新されます。</div><AutoRefresh seconds={4} /></>}
        {inStore && order.status === 'PENDING' && <div className="alert info" style={{ marginTop: 12, textAlign: 'left' }}>お支払い方法：店頭受け取り時にお支払い（デモ）<br />ご来店時にスタッフへ注文番号をお伝えください。</div>}
        {order.trackingNumber && <div className="alert success" style={{ marginTop: 12 }}>発送済み ・ お問い合わせ番号 <span className="mono">{order.trackingNumber}</span></div>}
      </div>
      <div className="card">
        <h2 style={{ marginBottom: 8 }}>ご注文内容</h2>
        {order.items.map((i) => (
          <div key={i.id} className="between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
            <span className="row"><Package size={16} className="muted" />{i.name} × {i.quantity}</span><span className="num">{yen(i.unitPrice * i.quantity)}</span>
          </div>
        ))}
        <div className="between" style={{ padding: '8px 0' }}><span>送料</span><span className="num">{order.shippingFee ? yen(order.shippingFee) : '無料'}</span></div>
        <div className="between" style={{ fontWeight: 800, fontSize: 16 }}><span>合計（税込）</span><span className="num">{yen(order.total)}</span></div>
      </div>
      {order.isSubscription && (
        <div className="card">
          <h2 className="row" style={{ marginBottom: 8 }}><Repeat size={16} />定期便</h2>
          {subs.length === 0 ? <div className="sub">お支払い確認後に定期便が開始されます。</div> : subs.map((s) => (
            <div key={s.id} className="sub">{order.items.find((i) => i.productId === s.productId)?.name}：{s.intervalDays}日ごと ・ 次回お届け予定 {fmtDate(s.nextShipAt)}</div>
          ))}
        </div>
      )}
      <Link href={`/store/${shop.slug}`} className="btn secondary block">ストアに戻る</Link>
      <div className="sub center">このページのURLはご注文内容の確認用です。第三者と共有しないでください。</div>
    </div>
  );
}
