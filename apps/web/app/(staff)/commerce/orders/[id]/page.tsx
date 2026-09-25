import Link from 'next/link';
import { notFound } from 'next/navigation';
import { maskEmail, maskPhone } from '@salonos/core';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';
import { decryptField, piiAccess } from '@/lib/server/pii';
import { Badge, Card, PageHeader } from '@/components/ui';
import { fmtDate, fmtDateTime, yen } from '@/lib/format';
import { SUB_STATUS_LABEL } from '@/lib/pos-shared';
import { OrderStatusBadge } from '../../_components/OrderStatusBadge';
import { OrderActions } from './OrderActions';

export const metadata = { title: '注文詳細' };

const ACTION_LABEL: Record<string, string> = {
  'commerce.order.paid': '支払い確認', 'commerce.order.fulfilled': '発送', 'commerce.order.cancelled': 'キャンセル', 'commerce.order.refunded': '返金', 'commerce.order.tracking': '伝票番号更新', 'order.pii.read': '連絡先閲覧',
};

export default async function OrderDetail({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage('commerce.manage');
  const { id } = await params;
  const o = await prisma.order.findFirst({ where: { id, organizationId: ctx.org.id }, include: { items: true, shop: { select: { name: true, slug: true } }, customer: { select: { id: true, lastName: true, firstName: true } } } });
  if (!o) notFound();
  const access = await piiAccess(ctx);
  const email = decryptField(o.contactEmailEnc), phone = decryptField(o.contactPhoneEnc), address = decryptField(o.shippingAddressEnc);
  if (access.canView) await audit(ctx, 'order.pii.read', 'Order', o.id, { via: access.via });
  const [subs, staff, rec, logs, products] = await Promise.all([
    prisma.subscription.findMany({ where: { orderId: o.id, organizationId: ctx.org.id } }),
    o.attributedStaffId ? prisma.membership.findFirst({ where: { organizationId: ctx.org.id, userId: o.attributedStaffId }, select: { displayName: true } }) : null,
    o.recommendationId ? prisma.productRecommendation.findFirst({ where: { id: o.recommendationId, organizationId: ctx.org.id } }) : null,
    prisma.auditLog.findMany({ where: { organizationId: ctx.org.id, resourceType: 'Order', resourceId: o.id, action: { not: 'order.pii.read' } }, orderBy: { createdAt: 'asc' } }),
    prisma.product.findMany({ where: { id: { in: o.items.map((i) => i.productId) }, organizationId: ctx.org.id }, select: { id: true, stock: true } }),
  ]);
  const online = !!o.paymentRef && !o.paymentRef.startsWith('sandbox_') && (o.paymentProvider === 'STRIPE' || o.paymentProvider === 'SQUARE');
  return (
    <>
      <PageHeader title={<>注文 #{o.number} <OrderStatusBadge status={o.status} /></>} sub={`${o.shop.name} ・ ${fmtDateTime(o.createdAt)}`} back={{ href: '/commerce/orders', label: '注文一覧' }}
        actions={<OrderActions orderId={o.id} status={o.status} trackingNumber={o.trackingNumber} online={online} />} />
      <div className="split">
        <div className="stack">
          <Card title="商品" flush>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>商品</th><th className="num">単価</th><th className="num">数量</th><th className="num">在庫</th><th className="num">小計</th></tr></thead>
                <tbody>
                  {o.items.map((i) => <tr key={i.id}><td><Link className="link" href={`/commerce/products/${i.productId}`}>{i.name}</Link></td><td className="num">{yen(i.unitPrice)}</td><td className="num">{i.quantity}</td><td className="num">{products.find((p) => p.id === i.productId)?.stock ?? '—'}</td><td className="num">{yen(i.unitPrice * i.quantity)}</td></tr>)}
                  <tr><td colSpan={4} className="right">小計</td><td className="num">{yen(o.subtotal)}</td></tr>
                  <tr><td colSpan={4} className="right">送料</td><td className="num">{yen(o.shippingFee)}</td></tr>
                  <tr><td colSpan={4} className="right"><strong>合計（税込）</strong></td><td className="num"><strong>{yen(o.total)}</strong></td></tr>
                </tbody>
              </table>
            </div>
          </Card>
          {subs.length > 0 && (
            <Card title="定期便" flush actions={<Link className="btn sm ghost" href="/commerce/subscriptions">定期便一覧</Link>}>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>商品</th><th>間隔</th><th>次回お届け</th><th>状態</th></tr></thead>
                  <tbody>{subs.map((s) => <tr key={s.id}><td>{o.items.find((i) => i.productId === s.productId)?.name ?? '—'} ×{s.quantity}</td><td>{s.intervalDays}日</td><td>{fmtDate(s.nextShipAt)}</td><td><Badge tone={s.status === 'ACTIVE' ? 'green' : s.status === 'PAUSED' ? 'amber' : 'gray'}>{SUB_STATUS_LABEL[s.status] ?? s.status}</Badge></td></tr>)}</tbody>
                </table>
              </div>
            </Card>
          )}
          <Card title="履歴">
            <div className="timeline">
              <div className="timeline-item"><div style={{ fontWeight: 700 }}>注文受付</div><div className="sub">{fmtDateTime(o.createdAt)}</div></div>
              {logs.map((l) => <div key={l.id} className="timeline-item"><div style={{ fontWeight: 700 }}>{ACTION_LABEL[l.action] ?? l.action}</div><div className="sub">{fmtDateTime(l.createdAt)}{(l.metadata as any)?.reason ? ` ・ ${(l.metadata as any).reason}` : ''}{(l.metadata as any)?.trackingNumber ? ` ・ 伝票 ${(l.metadata as any).trackingNumber}` : ''}{!l.userId ? ' ・ 自動' : ''}</div></div>)}
            </div>
          </Card>
        </div>
        <div className="stack">
          <Card title="お客様・配送先">
            {!access.canView && <div className="alert warn" style={{ marginBottom: 10 }}>連絡先はマスク表示です（閲覧権限がありません）</div>}
            <dl className="kv">
              <dt>お名前</dt><dd>{o.contactName}</dd>
              <dt>顧客</dt><dd>{o.customer ? <Link className="link" href={`/customers/${o.customer.id}`}>{o.customer.lastName} {o.customer.firstName}</Link> : '—'}</dd>
              <dt>メール</dt><dd>{access.canView ? email ?? '—' : maskEmail(email) ?? '—'}</dd>
              <dt>電話</dt><dd>{access.canView ? phone ?? '—' : maskPhone(phone) ?? '—'}</dd>
              <dt>配送先</dt><dd>{access.canView ? address ?? '—' : address ? '（ロック中）' : '—'}</dd>
            </dl>
          </Card>
          <Card title="支払い・配送">
            <dl className="kv">
              <dt>支払い</dt><dd>{o.paymentProvider === 'STRIPE' ? 'Stripe' : o.paymentProvider === 'SQUARE' ? 'Square' : o.paymentProvider === 'IN_STORE' ? '店頭払い' : '—'}</dd>
              <dt>決済ID</dt><dd className="mono">{o.paymentRef ?? '—'}</dd>
              <dt>発送日</dt><dd>{o.fulfilledAt ? fmtDateTime(o.fulfilledAt) : '—'}</dd>
              <dt>伝票番号</dt><dd className="mono">{o.trackingNumber ?? '—'}</dd>
            </dl>
          </Card>
          <Card title="アトリビューション">
            <dl className="kv">
              <dt>店舗</dt><dd>{o.shop.name}</dd>
              <dt>担当スタッフ</dt><dd>{staff?.displayName ?? '—'}</dd>
              <dt>おすすめ経由</dt><dd>{rec ? `${fmtDate(rec.createdAt)} 作成のリンク` : '—'}</dd>
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}
