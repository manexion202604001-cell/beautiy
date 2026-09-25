import Link from 'next/link';
import { ImageOff, Package, Plus } from 'lucide-react';
import type { Prisma } from '@salonos/db';
import { localToUtc, todayIn } from '@salonos/core';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { Badge, Card, Empty, PageHeader, Stat } from '@/components/ui';
import { yen } from '@/lib/format';
import { CommerceTabs } from './_components/CommerceTabs';

export const metadata = { title: '店販EC・商品' };

type SP = { q?: string; filter?: string };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePage('commerce.manage');
  const { q, filter } = await searchParams;
  const where: Prisma.ProductWhereInput = {
    organizationId: ctx.org.id,
    ...(filter === 'archived' ? { active: false } : { active: true }),
    ...(filter === 'online' ? { onlineSale: true } : {}),
    ...(filter === 'low' ? { stock: { lte: 3 } } : {}),
    ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { brand: { contains: q, mode: 'insensitive' } }, { sku: { contains: q, mode: 'insensitive' } }] } : {}),
  };
  const monthStart = localToUtc(`${todayIn(ctx.shop.timezone).slice(0, 8)}01`, 0, ctx.shop.timezone);
  const [products, total, outOfStock, monthSales, activeSubs] = await Promise.all([
    prisma.product.findMany({ where, orderBy: [{ brand: 'asc' }, { name: 'asc' }] }),
    prisma.product.count({ where: { organizationId: ctx.org.id, active: true } }),
    prisma.product.count({ where: { organizationId: ctx.org.id, active: true, stock: { lte: 0 } } }),
    prisma.order.aggregate({ where: { organizationId: ctx.org.id, status: { in: ['PAID', 'FULFILLED'] }, createdAt: { gte: monthStart } }, _sum: { total: true }, _count: true }),
    prisma.subscription.count({ where: { organizationId: ctx.org.id, status: 'ACTIVE' } }),
  ]);
  const filters = [{ k: '', l: '販売中' }, { k: 'online', l: 'オンライン販売' }, { k: 'low', l: '在庫僅少' }, { k: 'archived', l: '販売停止' }];

  return (
    <>
      <PageHeader title="店販EC" sub="商品・在庫・オンラインストア"
        actions={<>
          <a className="btn secondary" href={`/store/${ctx.shop.slug}`} target="_blank" rel="noreferrer">ストアを表示</a>
          <Link className="btn" href="/commerce/products/new"><Plus size={16} />商品を登録</Link>
        </>} />
      <CommerceTabs active="products" />
      <div className="grid-4" style={{ marginBottom: 14 }}>
        <Stat label="販売中の商品" value={`${total}点`} />
        <Stat label="在庫切れ" value={`${outOfStock}点`} tone={outOfStock ? 'down' : undefined} sub={outOfStock ? '補充が必要です' : '問題ありません'} />
        <Stat label="今月のEC売上" value={yen(monthSales._sum.total ?? 0)} sub={`${monthSales._count}件`} />
        <Stat label="継続中の定期便" value={`${activeSubs}件`} />
      </div>
      <Card flush>
        <div className="between" style={{ padding: '14px 18px', flexWrap: 'wrap' }}>
          <div className="seg">
            {filters.map((f) => <Link key={f.k} href={`/commerce?${new URLSearchParams({ ...(f.k ? { filter: f.k } : {}), ...(q ? { q } : {}) })}`} className={(filter ?? '') === f.k ? 'active' : ''}>{f.l}</Link>)}
          </div>
          <form className="row" action="/commerce">
            {filter && <input type="hidden" name="filter" value={filter} />}
            <input className="input sm" name="q" defaultValue={q ?? ''} placeholder="商品名・ブランド・SKU" aria-label="商品検索" />
            <button className="btn secondary sm">検索</button>
          </form>
        </div>
        {products.length === 0 ? (
          <Empty title={q || filter ? '該当する商品がありません' : '商品が登録されていません'} icon={<Package size={20} />}
            action={!q && !filter ? <Link className="btn" href="/commerce/products/new">最初の商品を登録</Link> : undefined}>
            {q || filter ? '条件を変更してください。' : 'POSの店販やオンラインストアで販売する商品を登録しましょう。'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th /><th>商品</th><th>SKU</th><th className="num">価格（税込）</th><th className="num">在庫</th><th>オンライン</th><th>定期便</th><th /></tr></thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id}>
                    <td style={{ width: 60 }}>{p.imageUrl ? <img className="product-thumb" src={p.imageUrl} alt="" /> : <span className="product-thumb"><ImageOff size={16} /></span>}</td>
                    <td><Link className="link" href={`/commerce/products/${p.id}`} style={{ fontWeight: 700 }}>{p.name}</Link><div className="sub">{p.brand ?? '—'}</div></td>
                    <td className="mono">{p.sku ?? '—'}</td>
                    <td className="num">{yen(p.price)}</td>
                    <td className="num">{p.stock <= 0 ? <Badge tone="red">在庫切れ {p.stock}</Badge> : p.stock <= 3 ? <Badge tone="amber">{p.stock}</Badge> : p.stock}</td>
                    <td>{p.onlineSale && p.active ? <Badge tone="green">販売中</Badge> : <Badge>非公開</Badge>}</td>
                    <td>{p.subscriptionIntervalDays ? `${p.subscriptionIntervalDays}日ごと` : '—'}</td>
                    <td className="right"><Link className="btn sm ghost" href={`/commerce/products/${p.id}`}>編集</Link></td>
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
