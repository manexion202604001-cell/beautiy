import { Link2 } from 'lucide-react';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { recommendationUrl } from '@/lib/server/commerce';
import { Card, Empty, PageHeader } from '@/components/ui';
import { CopyButton } from '@/components/client';
import { fmtDateTime, yen } from '@/lib/format';
import { CommerceTabs } from '../_components/CommerceTabs';
import { RecommendationForm } from './RecommendationForm';

export const metadata = { title: 'おすすめリンク' };

export default async function RecommendationsPage() {
  const ctx = await requirePage('commerce.manage');
  const [products, staffRows, recs] = await Promise.all([
    prisma.product.findMany({ where: { organizationId: ctx.org.id, active: true, onlineSale: true }, orderBy: [{ brand: 'asc' }, { name: 'asc' }], select: { id: true, name: true, brand: true, price: true } }),
    prisma.staffAssignment.findMany({ where: { shopId: ctx.shop.id, membership: { active: true } }, include: { membership: { select: { userId: true, displayName: true, sortOrder: true } } } }),
    prisma.productRecommendation.findMany({ where: { organizationId: ctx.org.id, shopId: { in: ctx.shops.map((s) => s.id) } }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);
  const [orders, customers, members] = await Promise.all([
    recs.length ? prisma.order.groupBy({ by: ['recommendationId'], where: { organizationId: ctx.org.id, recommendationId: { in: recs.map((r) => r.id) }, status: { in: ['PAID', 'FULFILLED'] } }, _count: true, _sum: { total: true } }) : [],
    prisma.customer.findMany({ where: { organizationId: ctx.org.id, id: { in: recs.map((r) => r.customerId).filter(Boolean) as string[] } }, select: { id: true, lastName: true, firstName: true } }),
    prisma.membership.findMany({ where: { organizationId: ctx.org.id, userId: { in: recs.map((r) => r.staffId) } }, select: { userId: true, displayName: true } }),
  ]);
  const staff = staffRows.map((s) => s.membership).sort((a, b) => a.sortOrder - b.sortOrder).map((m) => ({ id: m.userId, name: m.displayName }));
  return (
    <>
      <PageHeader title="店販EC" sub="お客様ごとのおすすめ商品リンク（購入はスタッフ・店舗に紐づきます）" />
      <CommerceTabs active="recommendations" />
      <div className="split">
        <Card title="新しいおすすめリンク">
          <RecommendationForm products={products} staff={staff} defaultStaffId={staff.some((s) => s.id === ctx.user.id) ? ctx.user.id : null} canSend={ctx.can('message.send')} canSearch={ctx.can('customer.read')} />
        </Card>
        <Card title="作成済みリンク" flush>
          {recs.length === 0 ? <Empty title="まだリンクはありません" icon={<Link2 size={20} />}>施術後のホームケア提案に使えます。</Empty> : (
            <div className="list" style={{ padding: '0 18px' }}>
              {recs.map((r) => {
                const o = orders.find((x) => x.recommendationId === r.id);
                const c = customers.find((x) => x.id === r.customerId);
                return (
                  <div key={r.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                    <div className="grow">
                      <div style={{ fontWeight: 700 }}>{c ? `${c.lastName} ${c.firstName} 様` : 'お客様指定なし'} ・ {r.productIds.length}点</div>
                      <div className="sub">{fmtDateTime(r.createdAt)} ・ {members.find((m) => m.userId === r.staffId)?.displayName ?? '—'}{o ? ` ・ 購入 ${o._count}件 ${yen(o._sum.total ?? 0)}` : ''}</div>
                      {r.message && <div className="sub" style={{ marginTop: 2 }}>「{r.message.slice(0, 60)}{r.message.length > 60 ? '…' : ''}」</div>}
                    </div>
                    <CopyButton text={recommendationUrl(r.token)} label="URLをコピー" />
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
