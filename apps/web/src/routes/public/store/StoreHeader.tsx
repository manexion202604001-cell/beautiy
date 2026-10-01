import { Link } from 'react-router';
import type { PublicProduct } from '../../../api/commerce';
import { Icon } from '../../../components/ui';
import { ShopHeader } from '../PublicShell';
import { cartCount, useCart } from './cart';

/** Store header: shop name + cart badge + my page */
export function StoreHeader({
  slug,
  name,
  sub = 'オンラインストア',
}: {
  slug: string;
  name: string;
  sub?: string;
}) {
  const { cart } = useCart(slug);
  const n = cartCount(cart);
  return (
    <ShopHeader
      name={name}
      sub={sub}
      right={
        <div className="flex items-center gap-1">
          <Link
            to={`/my/${slug}?tab=orders`}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-muted hover:bg-surface-2"
            aria-label="マイページ（注文履歴）"
          >
            <Icon name="user" size={18} />
          </Link>
          <Link
            to={`/store/${slug}/cart`}
            className="relative inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-primary hover:bg-primary-soft"
            aria-label={`カート（${n}点）`}
            data-testid="cart-link"
          >
            <Icon name="bag" size={18} />
            カート
            {n ? (
              <span
                className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-semibold text-white tabular"
                data-testid="cart-count"
              >
                {n}
              </span>
            ) : null}
          </Link>
        </div>
      }
    />
  );
}

export function StockLabel({ p }: { p: Pick<PublicProduct, 'stockStatus'> }) {
  if (p.stockStatus === 'out_of_stock')
    return <span className="text-xs font-medium text-danger">在庫切れ</span>;
  if (p.stockStatus === 'low')
    return <span className="text-xs font-medium text-warning">残りわずか</span>;
  return <span className="text-xs text-success">在庫あり</span>;
}
