import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TONE,
  commerceApi,
  commerceKeys,
  useProducts,
  type OrderStatus,
  type Product,
} from '../../../api/commerce';
import {
  CustomerPicker,
  type PickedCustomer,
} from '../../../components/appointments/CustomerPicker';
import { CopyLink } from '../../../components/forms/CopyLink';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  InlineLoading,
  Input,
  LoadMore,
  PageHeader,
  Segmented,
  Select,
  Stat,
  TBody,
  THead,
  TabPanel,
  Table,
  Tabs,
  Td,
  Textarea,
  Th,
  Tr,
  useToast,
} from '../../../components/ui';
import { errorMessage, newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDateTime, formatYen } from '../../../lib/format';
import { useDebounced, useStableKey } from '../../../lib/hooks';
import { addDays, todayIn } from '../../../lib/time';
import { OrderDrawer } from './OrderDrawer';
import { ProductDialog } from './ProductDialog';
import { StockDrawer } from './StockDrawer';

type Tab = 'products' | 'low' | 'orders' | 'sales';

export default function Commerce() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = [
    { value: 'products' as const, label: '商品', disabled: !can('product.manage') },
    { value: 'low' as const, label: '在庫僅少', disabled: !can('product.manage') },
    { value: 'orders' as const, label: 'EC注文', disabled: !can('order.manage') },
    {
      value: 'sales' as const,
      label: '売上',
      disabled: !(can('sales.read') || can('sales.read_own')),
    },
  ];
  const fallback = tabs.find((t) => !t.disabled)?.value ?? 'products';
  const requested = params.get('tab') as Tab | null;
  const tab: Tab =
    requested && tabs.some((t) => t.value === requested && !t.disabled) ? requested : fallback;
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="商品・EC" description="店販商品・在庫・オンラインストアの注文" />
      <Tabs idBase="commerce" label="商品・EC" value={tab} onChange={setTab} items={tabs} />
      <div className="pt-5">
        <TabPanel idBase="commerce" value={tab}>
          {tab === 'products' ? <ProductsTab /> : null}
          {tab === 'low' ? <LowStockTab /> : null}
          {tab === 'orders' ? <OrdersTab /> : null}
          {tab === 'sales' ? <SalesTab /> : null}
        </TabPanel>
      </div>
    </div>
  );
}

function ProductsTab() {
  const { currentShopId, can, currentShop } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [online, setOnline] = useState<'' | 'true' | 'false'>('');
  const [status, setStatus] = useState<'' | 'active' | 'inactive'>('');
  const dq = useDebounced(q.trim(), 250);
  const products = useProducts({
    shopId: currentShopId ?? undefined,
    q: dq || undefined,
    isOnline: online ? online === 'true' : undefined,
    status: status || undefined,
    limit: 50,
  });
  const rows = products.data?.pages.flatMap((p) => p.items) ?? [];
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [stockFor, setStockFor] = useState<Product | null>(null);
  const [sharing, setSharing] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);

  const remove = async (p: Product) => {
    try {
      await commerceApi.deleteProduct(p.id);
      toast.success('商品を削除しました');
      void qc.invalidateQueries({ queryKey: commerceKeys.all });
    } catch (e) {
      toast.error(e);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="検索" className="min-w-56 flex-1">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="商品名・SKU・ブランド・バーコード"
          />
        </Field>
        <Field label="EC">
          <Select value={online} onChange={(e) => setOnline(e.target.value as typeof online)}>
            <option value="">すべて</option>
            <option value="true">EC販売中</option>
            <option value="false">店頭のみ</option>
          </Select>
        </Field>
        <Field label="状態">
          <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="">すべて</option>
            <option value="active">販売中</option>
            <option value="inactive">販売停止</option>
          </Select>
        </Field>
        <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
          商品を登録
        </Button>
      </div>
      {products.isLoading ? <InlineLoading /> : null}
      {products.error ? (
        <ErrorState error={products.error} onRetry={() => void products.refetch()} />
      ) : null}
      {products.data && !rows.length ? (
        <EmptyState
          icon="bag"
          title="商品がありません"
          description="店販商品を登録すると、会計・カルテのおすすめ・ECで使えます。"
        />
      ) : null}
      {rows.length ? (
        <Table caption="商品一覧">
          <THead>
            <tr>
              <Th>商品</Th>
              <Th className="hidden md:table-cell">SKU / バーコード</Th>
              <Th className="text-right">税込価格</Th>
              <Th className="text-right" title={`${currentShop?.name ?? '店舗'} / EC倉庫`}>
                在庫 店舗/EC
              </Th>
              <Th>区分</Th>
              <Th />
            </tr>
          </THead>
          <TBody>
            {rows.map((p) => {
              const shopStock = p.stocks.find((s) => s.shop_id === currentShopId);
              const ecStock = p.stocks.find((s) => s.shop_id === null);
              return (
                <Tr key={p.id}>
                  <Td className="min-w-44">
                    <button
                      type="button"
                      className="text-left font-medium hover:underline"
                      onClick={() => setEditing(p)}
                    >
                      {p.name}
                    </button>
                    <span className="block text-xs text-muted">
                      {[p.brand, p.category].filter(Boolean).join(' ・ ') || '—'}
                    </span>
                  </Td>
                  <Td className="hidden font-mono text-xs md:table-cell">
                    {p.sku ?? '—'}
                    <span className="block text-muted">{p.barcode ?? ''}</span>
                  </Td>
                  <Td className="text-right tabular">{formatYen(p.price_inclusive)}</Td>
                  <Td className="text-right tabular">
                    {p.stock_managed ? (
                      <button
                        type="button"
                        className="hover:underline"
                        onClick={() => setStockFor(p)}
                      >
                        {shopStock?.quantity ?? 0} / {ecStock?.quantity ?? 0}
                      </button>
                    ) : (
                      <span className="text-muted">管理対象外</span>
                    )}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {p.is_online ? (
                        <Badge size="sm" tone="primary">
                          EC
                        </Badge>
                      ) : null}
                      <Badge size="sm">{p.shop_id ? '店舗' : '共通'}</Badge>
                      {p.status === 'inactive' ? (
                        <Badge size="sm" tone="neutral">
                          停止
                        </Badge>
                      ) : null}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    <Button size="xs" variant="ghost" onClick={() => setStockFor(p)}>
                      在庫
                    </Button>
                    {can('message.send') && p.is_online && p.status === 'active' ? (
                      <Button size="xs" variant="ghost" onClick={() => setSharing(p)}>
                        共有
                      </Button>
                    ) : null}
                    <Button
                      size="xs"
                      variant="ghost"
                      className="!text-danger"
                      onClick={() => setDeleting(p)}
                    >
                      削除
                    </Button>
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      ) : null}
      <LoadMore
        hasMore={!!products.hasNextPage}
        loading={products.isFetchingNextPage}
        onClick={() => void products.fetchNextPage()}
      />
      {editing ? (
        <ProductDialog
          product={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {stockFor ? (
        <StockDrawer key={stockFor.id} product={stockFor} onClose={() => setStockFor(null)} />
      ) : null}
      {sharing ? <ShareProductDialog product={sharing} onClose={() => setSharing(null)} /> : null}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="商品を削除しますか？"
        description="販売停止になり、ECからも非表示になります。過去の会計・注文の記録は残ります。"
        tone="danger"
        confirmLabel="削除する"
        onConfirm={() => deleting && void remove(deleting)}
      />
    </>
  );
}

function ShareProductDialog({ product, onClose }: { product: Product; onClose: () => void }) {
  const toast = useToast();
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [message, setMessage] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, regenerate] = useStableKey(newIdempotencyKey);
  const submit = async () => {
    if (!customer) return setError('お客様を選択してください');
    setBusy(true);
    setError(null);
    try {
      const r = await commerceApi.share(
        product.id,
        { customerId: customer.id, ...(message.trim() ? { message: message.trim() } : {}) },
        key,
      );
      setUrl(r.url);
      regenerate();
      toast.success(
        '商品のご案内を送信しました',
        'このリンクからの購入はあなたの紹介として計上されます',
      );
    } catch (e) {
      setError(errorMessage(e));
      regenerate();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`「${product.name}」をお客様に共有`}
      dismissable={!busy}
      footer={
        url ? (
          <Button variant="primary" onClick={onClose}>
            閉じる
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              キャンセル
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => void submit()}
              disabled={!customer}
            >
              送信する
            </Button>
          </>
        )
      }
    >
      {url ? (
        <div className="space-y-3">
          <Alert tone="success">お客様へメッセージを送信しました。</Alert>
          <CopyLink url={url} label="商品の紹介リンク" />
        </div>
      ) : (
        <div className="space-y-4">
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <CustomerPicker value={customer} onChange={setCustomer} />
          <Field label="メッセージ" optional>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="本日お使いしたトリートメントです。ご自宅でのケアにおすすめです。"
            />
          </Field>
        </div>
      )}
    </Dialog>
  );
}

function LowStockTab() {
  const { currentShopId, shops } = useAuth();
  const [shopId, setShopId] = useState(currentShopId ?? '');
  const q = useQuery({
    queryKey: commerceKeys.lowStock(shopId || undefined),
    queryFn: () => commerceApi.lowStock(shopId || undefined),
  });
  return (
    <>
      <div className="mb-4 max-w-xs">
        <Field label="保管場所">
          <Select value={shopId} onChange={(e) => setShopId(e.target.value)}>
            <option value="">すべて（EC倉庫含む）</option>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} /> : null}
      {q.data && !q.data.length ? (
        <EmptyState
          icon="check"
          title="発注点を下回る商品はありません"
          description="商品の在庫画面で発注点を設定できます。"
        />
      ) : null}
      {q.data?.length ? (
        <Table caption="在庫僅少">
          <THead>
            <tr>
              <Th>商品</Th>
              <Th>保管場所</Th>
              <Th className="text-right">在庫</Th>
              <Th className="text-right">発注点</Th>
              <Th className="text-right">不足</Th>
            </tr>
          </THead>
          <TBody>
            {q.data.map((r) => (
              <Tr key={`${r.product_id}-${r.shop_id ?? 'ec'}`}>
                <Td>
                  {r.name}
                  <span className="block font-mono text-xs text-muted">{r.sku ?? ''}</span>
                </Td>
                <Td>{r.location}</Td>
                <Td className="text-right tabular text-danger">{r.quantity}</Td>
                <Td className="text-right tabular">{r.reorder_point}</Td>
                <Td className="text-right tabular">{r.shortage}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : null}
    </>
  );
}

function OrdersTab() {
  const { timezone: tz } = useAuth();
  const [status, setStatus] = useState<OrderStatus | ''>('');
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useInfiniteQuery({
    queryKey: commerceKeys.orders({ status }),
    queryFn: ({ pageParam }) =>
      commerceApi.orders({ status: status || undefined, cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <div className="mb-4 max-w-xs">
        <Field label="状態">
          <Select value={status} onChange={(e) => setStatus(e.target.value as OrderStatus | '')}>
            <option value="">すべて</option>
            {(Object.keys(ORDER_STATUS_LABEL) as OrderStatus[]).map((s) => (
              <option key={s} value={s}>
                {ORDER_STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} /> : null}
      {q.data && !rows.length ? <EmptyState icon="bag" title="注文はまだありません" /> : null}
      {rows.length ? (
        <Table caption="EC注文">
          <THead>
            <tr>
              <Th>注文番号</Th>
              <Th>日時</Th>
              <Th>お客様</Th>
              <Th className="text-right">合計</Th>
              <Th>状態</Th>
            </tr>
          </THead>
          <TBody>
            {rows.map((o) => (
              <Tr key={o.id} interactive onClick={() => setOpenId(o.id)}>
                <Td className="font-mono text-xs">
                  <button type="button" className="hover:underline" onClick={() => setOpenId(o.id)}>
                    {o.order_number}
                  </button>
                </Td>
                <Td className="whitespace-nowrap tabular">{formatDateTime(o.created_at, tz)}</Td>
                <Td>{o.customer_name ?? o.shipping_address?.name ?? '—'}</Td>
                <Td className="text-right tabular">{formatYen(o.total)}</Td>
                <Td>
                  <Badge size="sm" tone={ORDER_STATUS_TONE[o.status]}>
                    {ORDER_STATUS_LABEL[o.status]}
                  </Badge>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : null}
      <LoadMore
        hasMore={!!q.hasNextPage}
        loading={q.isFetchingNextPage}
        onClick={() => void q.fetchNextPage()}
      />
      <OrderDrawer id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function SalesTab() {
  const { timezone: tz, currentShopId } = useAuth();
  const today = todayIn(tz);
  const [from, setFrom] = useState(addDays(today, -29));
  const [to, setTo] = useState(today);
  const [groupBy, setGroupBy] = useState<'product' | 'staff'>('product');
  const query = useMemo(
    () => ({ from, to, groupBy, shopId: currentShopId ?? undefined }),
    [from, to, groupBy, currentShopId],
  );
  const q = useQuery({
    queryKey: commerceKeys.sales(query),
    queryFn: () => commerceApi.sales(query),
    enabled: !!from && !!to && from <= to,
  });
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="開始日">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} max={to} />
        </Field>
        <Field label="終了日">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} min={from} />
        </Field>
        <Segmented
          label="集計単位"
          value={groupBy}
          onChange={setGroupBy}
          options={[
            { value: 'product', label: '商品別' },
            { value: 'staff', label: 'スタッフ別' },
          ]}
        />
      </div>
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} /> : null}
      {q.data ? (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4 rounded-2xl border border-border bg-surface p-5">
            <Stat label="合計" value={formatYen(q.data.totals.total)} />
            <Stat label="EC" value={formatYen(q.data.totals.online)} />
            <Stat label="店販" value={formatYen(q.data.totals.store)} />
          </div>
          {q.data.rows.length ? (
            <Table caption="売上">
              <THead>
                <tr>
                  <Th>{groupBy === 'product' ? '商品' : 'スタッフ'}</Th>
                  <Th className="text-right">数量</Th>
                  <Th className="hidden text-right sm:table-cell">EC</Th>
                  <Th className="hidden text-right sm:table-cell">店販</Th>
                  <Th className="text-right">合計</Th>
                </tr>
              </THead>
              <TBody>
                {q.data.rows.map((r, i) => (
                  <Tr key={`${r.productId ?? r.staffId ?? 'none'}-${i}`}>
                    <Td>{r.name}</Td>
                    <Td className="text-right tabular">{r.quantity}</Td>
                    <Td className="hidden text-right tabular sm:table-cell">
                      {formatYen(r.online.amount)}{' '}
                      <span className="text-xs text-muted">（{r.online.orders}件）</span>
                    </Td>
                    <Td className="hidden text-right tabular sm:table-cell">
                      {formatYen(r.store.amount)}{' '}
                      <span className="text-xs text-muted">（{r.store.transactions}件）</span>
                    </Td>
                    <Td className="text-right font-medium tabular">{formatYen(r.total)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          ) : (
            <EmptyState icon="chart" title="この期間の売上はありません" />
          )}
        </div>
      ) : null}
    </>
  );
}
