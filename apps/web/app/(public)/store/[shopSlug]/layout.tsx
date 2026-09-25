import Link from 'next/link';
import { notFound } from 'next/navigation';
import { storeShop } from '@/lib/server/commerce';
import { CartLink } from './_components/StoreClient';

export default async function StoreLayout({ children, params }: { children: React.ReactNode; params: Promise<{ shopSlug: string }> }) {
  const { shopSlug } = await params;
  const shop = await storeShop(shopSlug);
  if (!shop) notFound();
  return (
    <>
      <header className="store-head">
        <div className="store-head-inner">
          <Link href={`/store/${shop.slug}`} className="store-brand">{shop.name}<small>{shop.organization.name} オンラインストア</small></Link>
          <CartLink slug={shop.slug} />
        </div>
      </header>
      <main className="store-body">{children}</main>
      <footer className="store-body sub center" style={{ paddingTop: 0 }}>
        {shop.address && <div>{shop.address}</div>}
        {shop.phone && <div>TEL {shop.phone}</div>}
        <div style={{ marginTop: 6 }}>Powered by MANEXION Salon OS</div>
      </footer>
    </>
  );
}
