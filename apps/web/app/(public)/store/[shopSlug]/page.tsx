import type { Metadata } from 'next';
import Link from 'next/link';
import { Package, Repeat } from 'lucide-react';
import { storeProducts, storeShop } from '@/lib/server/commerce';
import { Empty } from '@/components/ui';
import { yen } from '@/lib/format';
import { AddToCartButton } from './_components/StoreClient';

export async function generateMetadata({ params }: { params: Promise<{ shopSlug: string }> }): Promise<Metadata> {
  const shop = await storeShop((await params).shopSlug);
  return { title: shop ? `${shop.name} オンラインストア` : 'オンラインストア' };
}

export default async function StorePage({ params, searchParams }: { params: Promise<{ shopSlug: string }>; searchParams: Promise<{ brand?: string }> }) {
  const { shopSlug } = await params;
  const { brand } = await searchParams;
  const shop = (await storeShop(shopSlug))!;
  const all = await storeProducts(shop.organizationId);
  const brands = [...new Set(all.map((p) => p.brand).filter(Boolean) as string[])];
  const products = brand ? all.filter((p) => p.brand === brand) : all;
  return (
    <>
      <div style={{ margin: '4px 0 14px' }}>
        <h1 style={{ fontSize: 20 }}>サロン専売ヘアケア</h1>
        <div className="sub">スタイリストが選んだホームケアアイテムをお届けします。5,500円以上で送料無料。</div>
      </div>
      {brands.length > 1 && (
        <div className="chips">
          <Link href={`/store/${shop.slug}`} className={`chip ${!brand ? 'on' : ''}`}>すべて</Link>
          {brands.map((b) => <Link key={b} href={`/store/${shop.slug}?brand=${encodeURIComponent(b)}`} className={`chip ${brand === b ? 'on' : ''}`}>{b}</Link>)}
        </div>
      )}
      {products.length === 0 ? (
        <div className="card"><Empty title="現在販売中の商品はありません" icon={<Package size={20} />}>しばらくしてから再度ご覧ください。</Empty></div>
      ) : (
        <div className="store-grid">
          {products.map((p) => (
            <div key={p.id} className="store-card">
              <Link href={`/store/${shop.slug}/p/${p.id}`} className="img" aria-label={p.name}>{p.imageUrl ? <img src={p.imageUrl} alt={p.name} /> : <Package size={36} />}</Link>
              <div className="body">
                {p.brand && <div className="sub">{p.brand}</div>}
                <Link href={`/store/${shop.slug}/p/${p.id}`} className="name">{p.name}</Link>
                {p.subscriptionIntervalDays && <div><span className="badge violet"><Repeat size={11} />定期便OK</span></div>}
                <div className="price num">{yen(p.price)}<span className="sub" style={{ fontWeight: 400 }}> 税込</span></div>
                <AddToCartButton slug={shop.slug} productId={p.id} disabled={p.stock <= 0} />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
