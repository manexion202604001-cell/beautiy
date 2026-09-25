import { notFound } from 'next/navigation';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { Card, PageHeader, Stat } from '@/components/ui';
import { fmtDateTime, yen } from '@/lib/format';
import { ProductForm, StockForm } from '../ProductForm';

export const metadata = { title: '商品を編集' };

export default async function ProductPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const ctx = await requirePage('commerce.manage');
  const { id } = await params;
  const { created } = await searchParams;
  const p = await prisma.product.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!p) notFound();
  const since = new Date(Date.now() - 90 * 86400000);
  const [logs, posSold, ecSold] = await Promise.all([
    prisma.auditLog.findMany({ where: { organizationId: ctx.org.id, resourceType: 'Product', resourceId: p.id, action: 'commerce.stock.adjust' }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.transactionItem.aggregate({ where: { productId: p.id, transaction: { status: { in: ['PAID', 'PARTIALLY_REFUNDED'] }, paidAt: { gte: since }, organizationId: ctx.org.id } }, _sum: { quantity: true } }),
    prisma.orderItem.aggregate({ where: { productId: p.id, order: { status: { in: ['PAID', 'FULFILLED'] }, createdAt: { gte: since }, organizationId: ctx.org.id } }, _sum: { quantity: true } }),
  ]);
  const users = await prisma.membership.findMany({ where: { organizationId: ctx.org.id, userId: { in: logs.map((l) => l.userId).filter(Boolean) as string[] } }, select: { userId: true, displayName: true } });
  return (
    <>
      <PageHeader title={p.name} sub={[p.brand, p.sku].filter(Boolean).join(' ・ ') || undefined} back={{ href: '/commerce', label: '商品一覧' }} />
      {created && <div className="alert success" style={{ marginBottom: 14 }}>商品を登録しました。</div>}
      <div className="split">
        <Card title="商品情報"><ProductForm product={p} /></Card>
        <div className="stack">
          <div className="grid-2">
            <Stat label="現在の在庫" value={p.stock} tone={p.stock <= 0 ? 'down' : undefined} sub={p.stock <= 0 ? '在庫切れ' : undefined} />
            <Stat label="90日の販売数" value={(posSold._sum.quantity ?? 0) + (ecSold._sum.quantity ?? 0)} sub={`店頭 ${posSold._sum.quantity ?? 0} / EC ${ecSold._sum.quantity ?? 0}`} />
          </div>
          <Card title="在庫調整"><StockForm productId={p.id} stock={p.stock} /></Card>
          <Card title="在庫調整履歴">
            {logs.length === 0 ? <div className="sub">調整履歴はありません（POS・ECの販売による増減は各取引に記録されます）</div> : (
              <div className="list">
                {logs.map((l) => {
                  const m = l.metadata as any;
                  return (
                    <div key={l.id} className="list-item">
                      <div className="grow"><div>{m?.reason ?? '—'}</div><div className="sub">{fmtDateTime(l.createdAt)} ・ {users.find((u) => u.userId === l.userId)?.displayName ?? '—'} ・ {m?.before} → {m?.after}</div></div>
                      <strong className={m?.delta > 0 ? 'diff-plus' : 'diff-minus'}>{m?.delta > 0 ? '+' : ''}{m?.delta}</strong>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
          <div className="sub">価格 {yen(p.price)} ・ 登録日 {fmtDateTime(p.createdAt)}</div>
        </div>
      </div>
    </>
  );
}
