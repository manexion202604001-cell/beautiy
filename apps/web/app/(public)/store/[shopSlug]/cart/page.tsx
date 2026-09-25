import { storeProducts, storeShop } from '@/lib/server/commerce';
import { stripeConfig } from '@/lib/server/payments/stripe';
import { CartClient } from './CartClient';

export const metadata = { title: 'カート・ご注文手続き' };

export default async function CartPage({ params, searchParams }: { params: Promise<{ shopSlug: string }>; searchParams: Promise<{ cancelled?: string }> }) {
  const { shopSlug } = await params;
  const { cancelled } = await searchParams;
  const shop = (await storeShop(shopSlug))!;
  const [products, stripe] = await Promise.all([storeProducts(shop.organizationId), stripeConfig(shop.organizationId, shop.id)]);
  return (
    <>
      <h1 style={{ fontSize: 20, margin: '4px 0 14px' }}>カート</h1>
      {cancelled && <div className="alert warn" style={{ marginBottom: 12 }}>お支払いがキャンセルされました。内容をご確認のうえ、再度お手続きください。</div>}
      <CartClient slug={shop.slug} products={products.map((p) => ({ id: p.id, name: p.name, brand: p.brand, price: p.price, stock: p.stock, imageUrl: p.imageUrl, subscriptionIntervalDays: p.subscriptionIntervalDays }))} onlinePayment={stripe.live} />
    </>
  );
}
