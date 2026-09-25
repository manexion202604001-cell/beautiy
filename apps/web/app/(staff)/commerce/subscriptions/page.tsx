import Link from 'next/link';
import { Repeat } from 'lucide-react';
import { toLocalParts } from '@salonos/core';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { Badge, Card, Empty, PageHeader } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { SUB_STATUS_LABEL } from '@/lib/pos-shared';
import { CommerceTabs } from '../_components/CommerceTabs';
import { SubActions } from './SubActions';

export const metadata = { title: '定期便' };
const STATUSES = ['ACTIVE', 'PAUSED', 'CANCELLED'];

export default async function SubscriptionsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await requirePage('commerce.manage');
  const sp = await searchParams;
  const status = STATUSES.includes(sp.status ?? '') ? sp.status! : 'ACTIVE';
  const subs = await prisma.subscription.findMany({ where: { organizationId: ctx.org.id, status }, orderBy: { nextShipAt: 'asc' }, take: 300 });
  const [customers, products, orders] = await Promise.all([
    prisma.customer.findMany({ where: { id: { in: subs.map((s) => s.customerId).filter(Boolean) as string[] }, organizationId: ctx.org.id }, select: { id: true, lastName: true, firstName: true } }),
    prisma.product.findMany({ where: { id: { in: subs.map((s) => s.productId) }, organizationId: ctx.org.id }, select: { id: true, name: true, stock: true } }),
    prisma.order.findMany({ where: { id: { in: subs.map((s) => s.orderId) }, organizationId: ctx.org.id }, select: { id: true, number: true, contactName: true } }),
  ]);
  const soon = Date.now() + 7 * 86400000;
  return (
    <>
      <PageHeader title="店販EC" sub="定期便の管理" />
      <CommerceTabs active="subscriptions" />
      <Card flush>
        <div style={{ padding: '14px 18px' }}>
          <div className="seg">{STATUSES.map((s) => <Link key={s} href={`/commerce/subscriptions?status=${s}`} className={status === s ? 'active' : ''}>{SUB_STATUS_LABEL[s]}</Link>)}</div>
        </div>
        {subs.length === 0 ? <Empty title={`${SUB_STATUS_LABEL[status]}の定期便はありません`} icon={<Repeat size={20} />}>定期便対応の商品がストアで購入されると、ここに表示されます。</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>お客様</th><th>商品</th><th>間隔</th><th>次回お届け</th><th>注文</th><th>状態</th><th /></tr></thead>
              <tbody>
                {subs.map((s) => {
                  const c = customers.find((x) => x.id === s.customerId), o = orders.find((x) => x.id === s.orderId), p = products.find((x) => x.id === s.productId);
                  return (
                    <tr key={s.id}>
                      <td>{c ? <Link className="link" href={`/customers/${c.id}`}>{c.lastName} {c.firstName}</Link> : o?.contactName ?? '—'}</td>
                      <td>{p?.name ?? '—'} ×{s.quantity}{p && p.stock < s.quantity && <> <Badge tone="red">在庫不足</Badge></>}</td>
                      <td>{s.intervalDays}日ごと</td>
                      <td>{fmtDate(s.nextShipAt)} {s.status === 'ACTIVE' && s.nextShipAt.getTime() < soon && <Badge tone="amber">{s.nextShipAt.getTime() < Date.now() ? '期限超過' : '7日以内'}</Badge>}</td>
                      <td>{o ? <Link className="link mono" href={`/commerce/orders/${o.id}`}>#{o.number}</Link> : '—'}</td>
                      <td><Badge tone={s.status === 'ACTIVE' ? 'green' : s.status === 'PAUSED' ? 'amber' : 'gray'}>{SUB_STATUS_LABEL[s.status]}</Badge></td>
                      <td className="right"><SubActions id={s.id} status={s.status} nextShipAt={toLocalParts(s.nextShipAt, 'Asia/Tokyo').date} /></td>
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
