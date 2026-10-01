import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  catalogApi,
  catalogKeys,
  useCategories,
  useCoupons,
  useMenus,
  useResources,
} from '../../../api/catalog';
import type { Coupon, EffectiveMenu, MenuCategory, Resource } from '../../../api/types';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  IconButton,
  InlineLoading,
  Input,
  PageHeader,
  Select,
  TBody,
  THead,
  TabPanel,
  Table,
  Tabs,
  Td,
  Th,
  Tr,
  useToast,
} from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { formatDate, formatDuration, formatYen, taxRateLabel } from '../../../lib/format';
import { CouponDialog } from './CouponDialog';
import { MenuDialog } from './MenuDialog';
import { OverrideDialog } from './OverrideDialog';
import { RESOURCE_TYPE_LABEL, resourceTypeLabel } from './shared';

type Tab = 'menus' | 'categories' | 'coupons' | 'resources';

export default function Menus() {
  const { currentShopId: shopId, currentShop } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'menus';
  const setTab = (t: Tab) => setParams(t === 'menus' ? {} : { tab: t }, { replace: true });
  if (!shopId) return <InlineLoading />;
  return (
    <div>
      <PageHeader
        title="メニュー"
        description={`${currentShop?.name ?? ''} で提供するメニュー・クーポン・席/設備を管理します。共通メニューは全店舗に表示され、店舗ごとに価格や時間を上書きできます。`}
      />
      <Tabs
        idBase="menus"
        label="メニュー管理"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'menus', label: 'メニュー' },
          { value: 'categories', label: 'カテゴリ' },
          { value: 'coupons', label: 'クーポン' },
          { value: 'resources', label: '席・設備' },
        ]}
      />
      <div className="pt-5">
        <TabPanel idBase="menus" value={tab}>
          {tab === 'menus' ? <MenusTab shopId={shopId} /> : null}
          {tab === 'categories' ? <CategoriesTab /> : null}
          {tab === 'coupons' ? <CouponsTab shopId={shopId} /> : null}
          {tab === 'resources' ? <ResourcesTab shopId={shopId} /> : null}
        </TabPanel>
      </div>
    </div>
  );
}

function MenusTab({ shopId }: { shopId: string }) {
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const menus = useMenus(shopId, true);
  const [editing, setEditing] = useState<EffectiveMenu | 'new' | null>(null);
  const [override, setOverride] = useState<EffectiveMenu | null>(null);
  const [deleting, setDeleting] = useState<EffectiveMenu | null>(null);
  const [filter, setFilter] = useState<'all' | 'common' | 'shop'>('all');
  const manage = can('menu.manage');
  const allShops = !!me?.allShops;

  const del = useMutation({
    mutationFn: (m: EffectiveMenu) => catalogApi.deleteMenu(m.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: catalogKeys.all });
      toast.success('メニューを削除しました');
      setDeleting(null);
    },
    onError: (e) => toast.error(e),
  });

  if (menus.isLoading) return <InlineLoading />;
  if (menus.error) return <ErrorState error={menus.error} onRetry={() => void menus.refetch()} />;
  const list = (menus.data ?? []).filter(
    (m) => filter === 'all' || (filter === 'common' ? !m.shopId : !!m.shopId),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="w-48">
          <label htmlFor="menu-filter" className="sr-only">
            表示するメニュー
          </label>
          <Select
            id="menu-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
          >
            <option value="all">すべてのメニュー</option>
            <option value="common">共通メニュー</option>
            <option value="shop">店舗独自メニュー</option>
          </Select>
        </div>
        {manage ? (
          <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
            メニューを追加
          </Button>
        ) : null}
      </div>
      {!list.length ? (
        <EmptyState
          icon="scissors"
          title="メニューがありません"
          description="「メニューを追加」から最初のメニューを登録しましょう。"
        />
      ) : (
        <Table caption="メニュー一覧">
          <THead>
            <tr>
              <Th>メニュー</Th>
              <Th>カテゴリ</Th>
              <Th className="text-right">所要時間</Th>
              <Th className="text-right">料金</Th>
              <Th>公開</Th>
              <Th>
                <span className="sr-only">操作</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {list.map((m) => {
              const editableBase = manage && (m.shopId ? true : allShops);
              return (
                <Tr key={m.id} className={m.status !== 'active' ? 'opacity-60' : undefined}>
                  <Td>
                    <p className="font-medium">{m.name}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {m.shopId ? (
                        <Badge size="sm" tone="info">
                          店舗独自
                        </Badge>
                      ) : (
                        <Badge size="sm">共通</Badge>
                      )}
                      {m.isOverridden ? (
                        <Badge size="sm" tone="warning">
                          店舗別上書き
                        </Badge>
                      ) : null}
                      {m.isConsultation ? (
                        <Badge size="sm" tone="primary">
                          相談予約
                        </Badge>
                      ) : null}
                      {m.newCustomerOnly ? (
                        <Badge size="sm" tone="primary">
                          新規限定
                        </Badge>
                      ) : null}
                      {m.resourceRequirements.length ? (
                        <Badge size="sm">
                          設備: {m.resourceRequirements.map((r) => r.resourceType).join(', ')}
                        </Badge>
                      ) : null}
                      {m.status === 'inactive' ? (
                        <Badge size="sm" tone="danger">
                          停止中
                        </Badge>
                      ) : null}
                      {m.status === 'unavailable' ? (
                        <Badge size="sm" tone="danger">
                          この店舗では提供なし
                        </Badge>
                      ) : null}
                    </div>
                  </Td>
                  <Td className="text-muted">{m.categoryName ?? '—'}</Td>
                  <Td className="whitespace-nowrap text-right tabular">
                    {formatDuration(m.durationMin)}
                    {m.bufferBeforeMin || m.bufferAfterMin ? (
                      <span className="block text-xs text-muted">
                        前{m.bufferBeforeMin}分 / 後{m.bufferAfterMin}分
                      </span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular">
                    {formatYen(m.price)}
                    <span className="block text-xs text-muted">
                      {m.priceTaxIncluded ? '税込' : '税抜'} {taxRateLabel(m.taxRateBp)}
                    </span>
                  </Td>
                  <Td>
                    {m.isPublic ? <Badge tone="success">Web公開</Badge> : <Badge>店内のみ</Badge>}
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    {manage ? (
                      <div className="flex justify-end gap-1">
                        {!m.shopId ? (
                          <Button size="xs" variant="ghost" onClick={() => setOverride(m)}>
                            店舗別設定
                          </Button>
                        ) : null}
                        {editableBase ? (
                          <IconButton
                            icon="edit"
                            label={`${m.name}を編集`}
                            size="sm"
                            onClick={() => setEditing(m)}
                          />
                        ) : null}
                        {editableBase ? (
                          <IconButton
                            icon="trash"
                            label={`${m.name}を削除`}
                            size="sm"
                            onClick={() => setDeleting(m)}
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      )}
      {!allShops && manage ? (
        <p className="text-xs text-muted">
          ※
          共通メニューの編集には全店舗権限が必要です。「店舗別設定」で価格・時間・提供可否を上書きできます。
        </p>
      ) : null}

      {editing ? (
        <MenuDialog
          shopId={shopId}
          menu={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {override ? (
        <OverrideDialog shopId={shopId} menu={override} onClose={() => setOverride(null)} />
      ) : null}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`「${deleting?.name ?? ''}」を削除しますか？`}
        description="過去の予約・会計の履歴には影響しません。"
        tone="danger"
        confirmLabel="削除する"
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting)}
      />
    </div>
  );
}

function CategoriesTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const cats = useCategories();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; sortOrder: number } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<MenuCategory | null>(null);
  const manage = can('menu.manage');
  const inv = () => qc.invalidateQueries({ queryKey: catalogKeys.all });
  const create = useMutation({
    mutationFn: () =>
      catalogApi.createCategory({ name: name.trim(), sortOrder: (cats.data?.length ?? 0) + 1 }),
    onSuccess: () => {
      setName('');
      void inv();
    },
    onError: (e) => toast.error(e),
  });
  const update = useMutation({
    mutationFn: (c: { id: string; name: string; sortOrder: number }) =>
      catalogApi.updateCategory(c.id, { name: c.name, sortOrder: c.sortOrder }),
    onSuccess: () => {
      setEditing(null);
      void inv();
    },
    onError: (e) => toast.error(e),
  });
  const del = useMutation({
    mutationFn: (c: MenuCategory) => catalogApi.deleteCategory(c.id),
    onSuccess: () => {
      setDeleting(null);
      void inv();
      toast.success('カテゴリを削除しました');
    },
    onError: (e) => toast.error(e),
  });
  if (cats.isLoading) return <InlineLoading />;
  return (
    <Card className="max-w-2xl">
      <ul className="divide-y divide-border">
        {(cats.data ?? []).map((c) => (
          <li key={c.id} className="flex items-center gap-3 py-2.5">
            {editing?.id === c.id ? (
              <>
                <label className="sr-only" htmlFor={`cat-${c.id}`}>
                  カテゴリ名
                </label>
                <Input
                  id={`cat-${c.id}`}
                  inputSize="sm"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  className="flex-1"
                />
                <label className="sr-only" htmlFor={`cat-sort-${c.id}`}>
                  表示順
                </label>
                <Input
                  id={`cat-sort-${c.id}`}
                  inputSize="sm"
                  type="number"
                  value={editing.sortOrder}
                  onChange={(e) => setEditing({ ...editing, sortOrder: Number(e.target.value) })}
                  className="w-20"
                />
                <Button
                  size="sm"
                  variant="primary"
                  loading={update.isPending}
                  onClick={() => update.mutate(editing)}
                >
                  保存
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  取消
                </Button>
              </>
            ) : (
              <>
                <span className="w-8 text-xs text-subtle tabular">{c.sort_order}</span>
                <span className="flex-1 text-[13px] font-medium">{c.name}</span>
                {c.shop_id ? (
                  <Badge size="sm" tone="info">
                    店舗独自
                  </Badge>
                ) : (
                  <Badge size="sm">共通</Badge>
                )}
                {manage ? (
                  <>
                    <IconButton
                      icon="edit"
                      label={`${c.name}を編集`}
                      size="sm"
                      onClick={() =>
                        setEditing({ id: c.id, name: c.name, sortOrder: c.sort_order })
                      }
                    />
                    <IconButton
                      icon="trash"
                      label={`${c.name}を削除`}
                      size="sm"
                      onClick={() => setDeleting(c)}
                    />
                  </>
                ) : null}
              </>
            )}
          </li>
        ))}
        {!cats.data?.length ? (
          <li className="py-3 text-[13px] text-muted">カテゴリがありません</li>
        ) : null}
      </ul>
      {manage ? (
        <form
          className="mt-4 flex gap-2 border-t border-border pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <label htmlFor="new-cat" className="sr-only">
            新しいカテゴリ名
          </label>
          <Input
            id="new-cat"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="新しいカテゴリ名"
            className="flex-1"
          />
          <Button type="submit" icon="plus" loading={create.isPending} disabled={!name.trim()}>
            追加
          </Button>
        </form>
      ) : null}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`カテゴリ「${deleting?.name ?? ''}」を削除しますか？`}
        description="このカテゴリのメニューは「未分類」になります。"
        tone="danger"
        confirmLabel="削除する"
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting)}
      />
    </Card>
  );
}

function couponValue(c: Coupon) {
  if (c.discount_type === 'percent') return `${c.discount_value}% OFF`;
  if (c.discount_type === 'amount') return `${formatYen(c.discount_value)} OFF`;
  return `${formatYen(c.discount_value)}（固定価格）`;
}

function CouponsTab({ shopId }: { shopId: string }) {
  const { can, timezone: tz } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const coupons = useCoupons(shopId);
  const [editing, setEditing] = useState<Coupon | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Coupon | null>(null);
  const manage = can('menu.manage');
  const del = useMutation({
    mutationFn: (c: Coupon) => catalogApi.deleteCoupon(c.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: catalogKeys.all });
      setDeleting(null);
      toast.success('クーポンを削除しました');
    },
    onError: (e) => toast.error(e),
  });
  if (coupons.isLoading) return <InlineLoading />;
  if (coupons.error) return <ErrorState error={coupons.error} />;
  return (
    <div className="space-y-4">
      {manage ? (
        <div className="flex justify-end">
          <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
            クーポンを追加
          </Button>
        </div>
      ) : null}
      {!coupons.data?.length ? (
        <EmptyState icon="gift" title="クーポンがありません" />
      ) : (
        <Table caption="クーポン一覧">
          <THead>
            <tr>
              <Th>クーポン</Th>
              <Th>割引</Th>
              <Th>条件</Th>
              <Th>有効期間</Th>
              <Th>状態</Th>
              <Th>
                <span className="sr-only">操作</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {coupons.data.map((c) => (
              <Tr key={c.id}>
                <Td>
                  <p className="font-medium">{c.name}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {c.shop_id ? (
                      <Badge size="sm" tone="info">
                        店舗限定
                      </Badge>
                    ) : (
                      <Badge size="sm">全店舗</Badge>
                    )}
                    {c.code ? (
                      <Badge size="sm" tone="outline">
                        コード: {c.code}
                      </Badge>
                    ) : null}
                    {c.is_public ? (
                      <Badge size="sm" tone="success">
                        予約画面に表示
                      </Badge>
                    ) : null}
                  </div>
                </Td>
                <Td className="whitespace-nowrap font-medium">{couponValue(c)}</Td>
                <Td className="text-xs text-muted">
                  {[
                    c.min_amount ? `${formatYen(c.min_amount)}以上` : null,
                    c.new_customer_only ? '新規限定' : null,
                    c.applicable_menu_ids.length
                      ? `対象メニュー${c.applicable_menu_ids.length}件`
                      : '全メニュー',
                    c.usage_limit ? `先着${c.usage_limit}回` : null,
                    c.per_customer_limit ? `1人${c.per_customer_limit}回まで` : null,
                  ]
                    .filter(Boolean)
                    .join(' ・ ')}
                </Td>
                <Td className="whitespace-nowrap text-xs text-muted">
                  {c.valid_from || c.valid_until
                    ? `${c.valid_from ? formatDate(c.valid_from, tz, { weekday: false }) : ''}〜${c.valid_until ? formatDate(c.valid_until, tz, { weekday: false }) : ''}`
                    : '無期限'}
                </Td>
                <Td>
                  {c.status === 'active' ? <Badge tone="success">有効</Badge> : <Badge>停止</Badge>}
                </Td>
                <Td className="whitespace-nowrap text-right">
                  {manage ? (
                    <div className="flex justify-end gap-1">
                      <IconButton
                        icon="edit"
                        label={`${c.name}を編集`}
                        size="sm"
                        onClick={() => setEditing(c)}
                      />
                      <IconButton
                        icon="trash"
                        label={`${c.name}を削除`}
                        size="sm"
                        onClick={() => setDeleting(c)}
                      />
                    </div>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      {editing ? (
        <CouponDialog
          shopId={shopId}
          coupon={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`「${deleting?.name ?? ''}」を削除しますか？`}
        tone="danger"
        confirmLabel="削除する"
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting)}
      />
    </div>
  );
}

function ResourcesTab({ shopId }: { shopId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const resources = useResources(shopId);
  const [name, setName] = useState('');
  const [type, setType] = useState('spa_bed');
  const [customType, setCustomType] = useState('');
  const [deleting, setDeleting] = useState<Resource | null>(null);
  const manage = can('menu.manage');
  const inv = () => qc.invalidateQueries({ queryKey: catalogKeys.resources(shopId) });
  const create = useMutation({
    mutationFn: () =>
      catalogApi.createResource({
        shopId,
        name: name.trim(),
        resourceType: type === '__custom' ? customType.trim() : type,
        sortOrder: (resources.data?.length ?? 0) + 1,
      }),
    onSuccess: () => {
      setName('');
      void inv();
      toast.success('席・設備を追加しました');
    },
    onError: (e) => toast.error(e),
  });
  const toggle = useMutation({
    mutationFn: (r: Resource) =>
      catalogApi.updateResource(r.id, { status: r.status === 'active' ? 'inactive' : 'active' }),
    onSuccess: () => void inv(),
    onError: (e) => toast.error(e),
  });
  const del = useMutation({
    mutationFn: (r: Resource) => catalogApi.deleteResource(r.id),
    onSuccess: () => {
      setDeleting(null);
      void inv();
    },
    onError: (e) => toast.error(e),
  });
  if (resources.isLoading) return <InlineLoading />;
  const groups = new Map<string, Resource[]>();
  for (const r of resources.data ?? [])
    groups.set(r.resource_type, [...(groups.get(r.resource_type) ?? []), r]);
  return (
    <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
      <Card>
        <h2 className="text-[15px] font-semibold">席・設備</h2>
        <p className="mt-0.5 text-[13px] text-muted">
          メニューに「必要な設備」を設定すると、空き枠計算で設備の空きも考慮されます（例: ヘッドスパ
          → スパベッド）。
        </p>
        {!groups.size ? (
          <p className="mt-4 text-[13px] text-muted">登録された席・設備はありません</p>
        ) : null}
        <div className="mt-4 space-y-4">
          {[...groups.entries()].map(([t, list]) => (
            <div key={t}>
              <p className="mb-1.5 text-xs font-semibold text-muted">
                {resourceTypeLabel(t)} <span className="font-mono text-subtle">({t})</span> ・{' '}
                {list.filter((r) => r.status === 'active').length}台稼働
              </p>
              <ul className="divide-y divide-border rounded-xl border border-border">
                {list.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="flex-1 text-[13px]">{r.name}</span>
                    {r.status === 'active' ? (
                      <Badge tone="success" size="sm">
                        稼働
                      </Badge>
                    ) : (
                      <Badge size="sm">停止</Badge>
                    )}
                    {manage ? (
                      <>
                        <Button size="xs" variant="ghost" onClick={() => toggle.mutate(r)}>
                          {r.status === 'active' ? '停止' : '再開'}
                        </Button>
                        <IconButton
                          icon="trash"
                          label={`${r.name}を削除`}
                          size="xs"
                          onClick={() => setDeleting(r)}
                        />
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>
      {manage ? (
        <Card className="h-fit">
          <h2 className="mb-3 text-[15px] font-semibold">追加</h2>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && (type !== '__custom' || customType.trim())) create.mutate();
            }}
          >
            <div>
              <label htmlFor="res-name" className="mb-1 block text-[13px] font-medium">
                名称
              </label>
              <Input
                id="res-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="スパベッド3"
              />
            </div>
            <div>
              <label htmlFor="res-type" className="mb-1 block text-[13px] font-medium">
                種類
              </label>
              <Select id="res-type" value={type} onChange={(e) => setType(e.target.value)}>
                {Object.entries(RESOURCE_TYPE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}（{k}）
                  </option>
                ))}
                <option value="__custom">その他（英字で入力）</option>
              </Select>
            </div>
            {type === '__custom' ? (
              <div>
                <label htmlFor="res-custom" className="mb-1 block text-[13px] font-medium">
                  種類キー
                </label>
                <Input
                  id="res-custom"
                  value={customType}
                  onChange={(e) => setCustomType(e.target.value.replace(/[^a-z0-9_]/g, ''))}
                  placeholder="foot_bath"
                />
              </div>
            ) : null}
            <Button type="submit" variant="primary" icon="plus" loading={create.isPending}>
              追加する
            </Button>
          </form>
        </Card>
      ) : null}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`「${deleting?.name ?? ''}」を削除しますか？`}
        tone="danger"
        confirmLabel="削除する"
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting)}
      />
    </div>
  );
}
