import Link from 'next/link';
import { ShoppingBag } from 'lucide-react';
import type { OrderStatus } from '@salonos/db';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { Badge, Card, Empty, PageHeader } from '@/components/ui';
import { fmtDateTime, yen } from '@/lib/format';
import { ORDER_STATUS_LABEL } from '@/lib/pos-shared';
import { CommerceTabs } from '../_components/CommerceTabs';
import { OrderStatusBadge } from '../_components/OrderStatusBadge';

export const metadata = { title: '注文一覧' };
const STATUSES = Object.keys(ORDER_STATUS_LABEL) as OrderStatus[];

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const ctx = await requirePage('commerce.manage');
  const sp = await searchParams;
  const status = STATUSES.includes(sp.status as OrderStatus) ? (sp.status as OrderStatus) : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const where = { organizationId: ctx.org.id, ...(status ? { status } : {}) };
  const [orders, count, counts] = await Promise.all([
    prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 50, take: 50, include: { items: { select: { name: true, quantity: true } }, shop: { select: { name: true } } } }),
    prisma.order.count({ where }),
    prisma.order.groupBy({ by: ['status'], where: { organizationId: ctx.org.id }, _count: true }),
  ]);
  const staffIds = [...new Set(orders.map((o) => o.attributedStaffId).filter(Boolean) as string[])];
  const staff = staffIds.length ? await prisma.membership.findMany({ where: { organizationId: ctx.org.id, userId: { in: staffIds } }, select: { userId: true, displayName: true } }) : [];
  const cnt = (s?: OrderStatus) => s ? counts.find((c) => c.status === s)?._count ?? 0 : counts.reduce((a, c) => a + c._count, 0);
  return (
    <>
      <PageHeader title="店販EC" sub="オンラインストアの注文" />
      <CommerceTabs active="orders" />
      <Card flush>
        <div style={{ padding: '14px 18px' }}>
          <div className="seg" style={{ flexWrap: 'wrap' }}>
            <Link href="/commerce/orders" className={!status ? 'active' : ''}>すべて（{cnt()}）</Link>
            {STATUSES.map((s) => <Link key={s} href={`/commerce/orders?status=${s}`} className={status === s ? 'active' : ''}>{ORDER_STATUS_LABEL[s]}（{cnt(s)}）</Link>)}
          </div>
        </div>
        {orders.length === 0 ? <Empty title="注文はまだありません" icon={<ShoppingBag size={20} />}>おすすめリンクやストアURLをお客様に共有しましょう。</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>注文番号</th><th>日時</th><th>お名前</th><th>商品</th><th>店舗 / 担当</th><th>状態</th><th className="num">合計</th><th /></tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="mono">#{o.number}</td>
                    <td className="nowrap">{fmtDateTime(o.createdAt)}</td>
                    <td>{o.contactName}{o.isSubscription && <> <Badge tone="violet">定期便</Badge></>}</td>
                    <td className="sub">{o.items.map((i) => `${i.name}×${i.quantity}`).join('、')}</td>
                    <td className="sub">{o.shop.name}{o.attributedStaffId ? ` / ${staff.find((s) => s.userId === o.attributedStaffId)?.displayName ?? '—'}` : ''}</td>
                    <td><OrderStatusBadge status={o.status} /></td>
                    <td className="num">{yen(o.total)}</td>
                    <td className="right"><Link className="btn sm ghost" href={`/commerce/orders/${o.id}`}>詳細</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {count > 50 && (
        <div className="between section">
          <span className="sub">{count}件</span>
          <div className="toolbar">
            {page > 1 && <Link className="btn secondary sm" href={`/commerce/orders?${new URLSearchParams({ ...(status ? { status } : {}), page: String(page - 1) })}`}>前へ</Link>}
            {page * 50 < count && <Link className="btn secondary sm" href={`/commerce/orders?${new URLSearchParams({ ...(status ? { status } : {}), page: String(page + 1) })}`}>次へ</Link>}
          </div>
        </div>
      )}
    </>
  );
}
