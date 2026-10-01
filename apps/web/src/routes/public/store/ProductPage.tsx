import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { storeApi } from '../../../api/commerce';
import { sameOriginBlobUrl } from '../../../api/files';
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  PageSpinner,
  useToast,
} from '../../../components/ui';
import { isApiError } from '../../../lib/api';
import { customerSession } from '../../../lib/session';
import { cn } from '../../../lib/cn';
import { formatYen } from '../../../lib/format';
import { taxRateText } from '../../../lib/money';
import { PublicShell, ShopHeader } from '../PublicShell';
import { MAX_QTY, addItem, captureRef, lastStore, rememberStore, useCart } from './cart';
import { StockLabel, StoreHeader } from './StoreHeader';

/** /store/products/:id (also /shop/:shopSlug/products/:id from shared links) */
export default function ProductPage() {
  const { id = '', shopSlug: slugParam } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['public', 'product', id],
    queryFn: () => storeApi.product(id),
    retry: false,
  });
  const query = new URLSearchParams(location.search);
  const slug =
    slugParam ??
    query.get('shop') ??
    q.data?.seller?.shopSlug ??
    lastStore() ??
    customerSession.lastSlug() ??
    '';
  const { update } = useCart(slug);
  const [qty, setQty] = useState(1);
  const [imageIdx, setImageIdx] = useState(0);
  useEffect(() => {
    captureRef(location.search);
    if (slug) rememberStore(slug);
  }, [location.search, slug]);

  if (q.isLoading) return <PageSpinner />;
  if (q.error || !q.data) {
    return (
      <PublicShell>
        <EmptyState
          className="mt-10"
          icon="bag"
          title={
            isApiError(q.error) && q.error.status === 404
              ? 'この商品は現在販売していません'
              : '読み込みに失敗しました'
          }
          action={
            slug ? <Button onClick={() => navigate(`/store/${slug}`)}>ストアへ</Button> : undefined
          }
        />
      </PublicShell>
    );
  }
  const p = q.data;
  const add = () => {
    if (!slug) return toast.error('ストアが特定できません');
    update((c) =>
      addItem(
        c,
        { productId: p.id, name: p.name, price: p.price, image: p.images[0] ?? null },
        qty,
      ),
    );
    toast.success('カートに追加しました', `${p.name} × ${qty}`);
  };
  return (
    <PublicShell
      header={
        slug ? (
          <StoreHeader slug={slug} name={p.seller?.name ?? 'オンラインストア'} />
        ) : (
          <ShopHeader name={p.seller?.name ?? 'オンラインストア'} />
        )
      }
      footer={
        <div className="fixed inset-x-0 bottom-0 border-t border-border bg-surface/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          <div className="mx-auto flex max-w-xl items-center gap-3">
            <div className="flex items-center gap-1" role="group" aria-label="数量">
              <IconButton
                icon="chevron-down"
                label="数量を減らす"
                variant="outline"
                size="sm"
                disabled={qty <= 1}
                onClick={() => setQty((n) => n - 1)}
              />
              <span className="w-8 text-center tabular" aria-live="polite">
                {qty}
              </span>
              <IconButton
                icon="chevron-up"
                label="数量を増やす"
                variant="outline"
                size="sm"
                disabled={qty >= MAX_QTY}
                onClick={() => setQty((n) => n + 1)}
              />
            </div>
            <Button
              variant="primary"
              size="lg"
              className="flex-1"
              icon="bag"
              disabled={!p.inStock}
              onClick={add}
              data-testid="add-to-cart"
            >
              {p.inStock ? 'カートに入れる' : '在庫切れ'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="-mx-4 mb-4">
        {p.images.length ? (
          <img
            src={sameOriginBlobUrl(p.images[imageIdx] ?? p.images[0]!)}
            alt={p.name}
            className="aspect-square w-full bg-surface-2 object-cover"
          />
        ) : (
          <span className="flex aspect-[4/3] items-center justify-center bg-surface-2 text-subtle">
            <Icon name="bag" size={48} />
          </span>
        )}
        {p.images.length > 1 ? (
          <div className="mt-2 flex gap-2 px-4">
            {p.images.map((u, i) => (
              <button
                key={u}
                type="button"
                onClick={() => setImageIdx(i)}
                aria-label={`画像${i + 1}を表示`}
                className={cn(
                  'h-14 w-14 overflow-hidden rounded-lg border-2',
                  i === imageIdx ? 'border-primary' : 'border-transparent',
                )}
              >
                <img src={sameOriginBlobUrl(u)} alt="" className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {p.brand ? <p className="text-xs text-muted">{p.brand}</p> : null}
      <h1 className="text-lg font-semibold leading-snug">{p.name}</h1>
      <p className="mt-2 text-xl font-semibold tabular">
        {formatYen(p.price)}
        <span className="ml-1 text-xs font-normal text-muted">
          （税込・{taxRateText(p.taxRateBp)}）
        </span>
      </p>
      <div className="mt-1">
        <StockLabel p={p} />
      </div>
      {p.description ? (
        <p className="mt-4 whitespace-pre-wrap text-[13px] leading-relaxed">{p.description}</p>
      ) : null}
      <p className="mt-6 text-xs text-subtle">
        送料は注文時に計算されます。販売: {p.seller?.name ?? '—'}
      </p>
    </PublicShell>
  );
}
