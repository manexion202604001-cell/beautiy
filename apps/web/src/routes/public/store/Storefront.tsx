import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { storeApi } from '../../../api/commerce';
import { sameOriginBlobUrl } from '../../../api/files';
import { publicApi } from '../../../api/public';
import {
  EmptyState,
  ErrorState,
  Icon,
  LoadMore,
  PageSpinner,
  useToast,
} from '../../../components/ui';
import { cn } from '../../../lib/cn';
import { formatYen } from '../../../lib/format';
import { PublicShell } from '../PublicShell';
import { addItem, captureRef, rememberStore, useCart } from './cart';
import { StockLabel, StoreHeader } from './StoreHeader';

/** /store/:shopSlug — EC storefront */
export default function Storefront() {
  const { shopSlug = '' } = useParams();
  const location = useLocation();
  const toast = useToast();
  const [category, setCategory] = useState('');
  const shop = useQuery({
    queryKey: ['public', 'shop', shopSlug],
    queryFn: () => publicApi.shop(shopSlug),
    retry: false,
  });
  const q = useInfiniteQuery({
    queryKey: ['public', 'store', shopSlug, category],
    queryFn: ({ pageParam }) =>
      storeApi.products(shopSlug, {
        cursor: pageParam,
        limit: 40,
        category: category || undefined,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });
  const { update } = useCart(shopSlug);
  useEffect(() => {
    rememberStore(shopSlug);
    captureRef(location.search);
  }, [shopSlug, location.search]);
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const [categories, setCategories] = useState<string[]>([]);
  useEffect(() => {
    if (!category && rows.length)
      setCategories([...new Set(rows.map((p) => p.category).filter((c): c is string => !!c))]);
  }, [rows, category]);

  if (shop.isLoading) return <PageSpinner />;
  if (shop.error) {
    return (
      <PublicShell>
        <ErrorState className="mt-10" error={shop.error} />
      </PublicShell>
    );
  }
  const name = shop.data!.shop.name;
  return (
    <PublicShell header={<StoreHeader slug={shopSlug} name={name} />}>
      <h1 className="mb-1 text-lg font-semibold">オンラインストア</h1>
      <p className="mb-4 text-[13px] text-muted">
        サロン専売品をご自宅にお届けします。価格はすべて税込です。
      </p>
      {categories.length > 1 ? (
        <div
          className="scrollbar-thin -mx-4 mb-4 flex gap-2 overflow-x-auto px-4"
          role="tablist"
          aria-label="カテゴリ"
        >
          {['', ...categories].map((c) => (
            <button
              key={c || 'all'}
              type="button"
              role="tab"
              aria-selected={category === c}
              onClick={() => setCategory(c)}
              className={cn(
                'shrink-0 rounded-full border px-3 py-1.5 text-[13px]',
                category === c
                  ? 'border-primary bg-primary text-primary-fg'
                  : 'border-border bg-surface text-fg',
              )}
            >
              {c || 'すべて'}
            </button>
          ))}
        </div>
      ) : null}
      {q.isLoading ? <PageSpinner /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !rows.length ? (
        <EmptyState icon="bag" title="現在販売中の商品はありません" />
      ) : null}
      <ul className="grid grid-cols-2 gap-3" data-testid="store-products">
        {rows.map((p) => (
          <li
            key={p.id}
            className="flex flex-col overflow-hidden rounded-2xl border border-border bg-surface"
          >
            <Link to={`/store/products/${p.id}?shop=${shopSlug}`} className="block">
              {p.images[0] ? (
                <img
                  src={sameOriginBlobUrl(p.images[0])}
                  alt=""
                  className="aspect-square w-full bg-surface-2 object-cover"
                  loading="lazy"
                />
              ) : (
                <span className="flex aspect-square items-center justify-center bg-surface-2 text-subtle">
                  <Icon name="bag" size={32} />
                </span>
              )}
              <span className="block px-3 pt-2">
                {p.brand ? (
                  <span className="block truncate text-[11px] text-muted">{p.brand}</span>
                ) : null}
                <span className="line-clamp-2 text-[13px] font-medium leading-snug">{p.name}</span>
              </span>
            </Link>
            <div className="mt-auto flex items-end justify-between gap-2 px-3 pb-3 pt-1">
              <div>
                <p className="text-sm font-semibold tabular">{formatYen(p.price)}</p>
                <StockLabel p={p} />
              </div>
              <button
                type="button"
                disabled={!p.inStock}
                onClick={() => {
                  update((c) =>
                    addItem(c, {
                      productId: p.id,
                      name: p.name,
                      price: p.price,
                      image: p.images[0] ?? null,
                    }),
                  );
                  toast.success('カートに追加しました', p.name);
                }}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-fg disabled:opacity-40"
                aria-label={`${p.name}をカートに追加`}
              >
                <Icon name="plus" size={18} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      <LoadMore
        hasMore={!!q.hasNextPage}
        loading={q.isFetchingNextPage}
        onClick={() => void q.fetchNextPage()}
      />
    </PublicShell>
  );
}
