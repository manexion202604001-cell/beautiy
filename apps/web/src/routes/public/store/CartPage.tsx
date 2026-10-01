import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { sameOriginBlobUrl } from '../../../api/files';
import { publicApi } from '../../../api/public';
import { ButtonLink, EmptyState, Icon, IconButton, PageSpinner } from '../../../components/ui';
import { formatYen } from '../../../lib/format';
import { PublicShell } from '../PublicShell';
import { MAX_QTY, cartCount, cartSubtotal, removeItem, setQuantity, useCart } from './cart';
import { StoreHeader } from './StoreHeader';

/** /store/:shopSlug/cart */
export default function CartPage() {
  const { shopSlug = '' } = useParams();
  const shop = useQuery({
    queryKey: ['public', 'shop', shopSlug],
    queryFn: () => publicApi.shop(shopSlug),
    retry: false,
  });
  const { cart, update } = useCart(shopSlug);
  if (shop.isLoading) return <PageSpinner />;
  const name = shop.data?.shop.name ?? 'オンラインストア';
  return (
    <PublicShell
      header={<StoreHeader slug={shopSlug} name={name} sub="カート" />}
      footer={
        cart.items.length ? (
          <div className="fixed inset-x-0 bottom-0 border-t border-border bg-surface/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
            <div className="mx-auto flex max-w-xl items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted">小計（{cartCount(cart)}点・税込）</p>
                <p className="text-lg font-semibold tabular" data-testid="cart-subtotal">
                  {formatYen(cartSubtotal(cart))}
                </p>
              </div>
              <ButtonLink
                to={`/store/${shopSlug}/checkout`}
                variant="primary"
                size="lg"
                data-testid="go-checkout"
              >
                ご購入手続きへ
              </ButtonLink>
            </div>
          </div>
        ) : undefined
      }
    >
      <h1 className="mb-4 text-lg font-semibold">カート</h1>
      {!cart.items.length ? (
        <EmptyState
          icon="bag"
          title="カートは空です"
          action={
            <ButtonLink to={`/store/${shopSlug}`} variant="primary">
              商品を見る
            </ButtonLink>
          }
        />
      ) : (
        <>
          <ul className="space-y-2.5">
            {cart.items.map((i) => (
              <li
                key={i.productId}
                className="flex gap-3 rounded-2xl border border-border bg-surface p-3"
              >
                <Link to={`/store/products/${i.productId}?shop=${shopSlug}`} className="shrink-0">
                  {i.image ? (
                    <img
                      src={sameOriginBlobUrl(i.image)}
                      alt=""
                      className="h-16 w-16 rounded-xl bg-surface-2 object-cover"
                    />
                  ) : (
                    <span className="flex h-16 w-16 items-center justify-center rounded-xl bg-surface-2 text-subtle">
                      <Icon name="bag" size={22} />
                    </span>
                  )}
                </Link>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-[13px] font-medium">{i.name}</p>
                  <p className="text-sm font-semibold tabular">{formatYen(i.price * i.quantity)}</p>
                  <div
                    className="mt-1 flex items-center gap-1"
                    role="group"
                    aria-label={`${i.name}の数量`}
                  >
                    <IconButton
                      icon="chevron-down"
                      label="数量を減らす"
                      size="xs"
                      variant="outline"
                      onClick={() => update((c) => setQuantity(c, i.productId, i.quantity - 1))}
                    />
                    <span className="w-7 text-center text-sm tabular">{i.quantity}</span>
                    <IconButton
                      icon="chevron-up"
                      label="数量を増やす"
                      size="xs"
                      variant="outline"
                      disabled={i.quantity >= MAX_QTY}
                      onClick={() => update((c) => setQuantity(c, i.productId, i.quantity + 1))}
                    />
                    <button
                      type="button"
                      className="ml-auto text-xs text-danger"
                      onClick={() => update((c) => removeItem(c, i.productId))}
                    >
                      削除
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-muted">
            送料はご注文時に計算されます。価格・在庫は注文確定時に再確認されます。
          </p>
          <Link to={`/store/${shopSlug}`} className="mt-4 inline-block text-[13px] text-primary">
            ‹ 買い物を続ける
          </Link>
        </>
      )}
    </PublicShell>
  );
}
