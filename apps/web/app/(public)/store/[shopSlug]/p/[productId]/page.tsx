import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Package, Repeat, Truck } from 'lucide-react';
import { prisma } from '@/lib/server/db';
import { storeShop } from '@/lib/server/commerce';
import { yen } from '@/lib/format';
import { STORE_FREE_SHIPPING_FROM, STORE_SHIPPING_FEE } from '@/lib/pos-shared';
import { AddToCartButton } from '../../_components/StoreClient';

async function load(slug: string, id: string) {
  const shop = await storeShop(slug);
  if (!shop) return null;
  const p = await prisma.product.findFirst({ where: { id, organizationId: shop.organizationId, active: true, onlineSale: true } });
  return p ? { shop, p } : null;
}

export async function generateMetadata({ params }: { params: Promise<{ shopSlug: string; productId: string }> }): Promise<Metadata> {
  const { shopSlug, productId } = await params;
  const r = await load(shopSlug, productId);
  return { title: r ? `${r.p.name} | ${r.shop.name}` : '商品が見つかりません', description: r?.p.description?.slice(0, 120) };
}

export default async function ProductDetail({ params }: { params: Promise<{ shopSlug: string; productId: string }> }) {
  const { shopSlug, productId } = await params;
  const r = await load(shopSlug, productId);
  if (!r) notFound();
  const { shop, p } = r;
  return (
    <>
      <Link href={`/store/${shop.slug}`} className="sub link">← 商品一覧</Link>
      <div className="store-detail" style={{ marginTop: 10 }}>
        <div className="store-hero-img card flush" style={{ borderRadius: 18 }}>{p.imageUrl ? <img src={p.imageUrl} alt={p.name} /> : <Package size={56} />}</div>
        <div className="stack">
          {p.brand && <div className="sub">{p.brand}</div>}
          <h1 style={{ fontSize: 22 }}>{p.name}</h1>
          <div style={{ fontSize: 24, fontWeight: 800 }} className="num">{yen(p.price)} <span className="sub" style={{ fontWeight: 400 }}>税込</span></div>
          {p.subscriptionIntervalDays && <div className="alert info"><Repeat size={14} /> 定期便に対応しています（{p.subscriptionIntervalDays}日ごとにお届け）。カートでお選びいただけます。</div>}
          <AddToCartButton slug={shop.slug} productId={p.id} disabled={p.stock <= 0} withQty block />
          {p.stock > 0 && p.stock <= 3 && <div className="sub">残りわずか（{p.stock}点）</div>}
          <div className="sub row"><Truck size={14} />送料 {yen(STORE_SHIPPING_FEE)}（{yen(STORE_FREE_SHIPPING_FROM)}以上で無料）・店頭受け取りも可能です</div>
          {p.description && <div className="card" style={{ whiteSpace: 'pre-wrap' }}>{p.description}</div>}
        </div>
      </div>
    </>
  );
}
