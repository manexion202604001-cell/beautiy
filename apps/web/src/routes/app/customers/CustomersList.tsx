import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  customersApi,
  useCustomerSearch,
  useTags,
  type CustomerSearch,
} from '../../../api/customers';
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  InlineLoading,
  Input,
  LoadMore,
  PageHeader,
  Select,
  TBody,
  THead,
  Table,
  TagChip,
  Td,
  Th,
  Tr,
  useToast,
} from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { formatDate, formatRelativeDay, formatYen } from '../../../lib/format';
import { useDebounced } from '../../../lib/hooks';

const SORTS = [
  { value: 'last_visit', label: '最終来店が新しい順' },
  { value: 'total_sales', label: '累計売上が多い順' },
  { value: 'created', label: '登録が新しい順' },
  { value: 'name', label: 'フリガナ順' },
] as const;

export default function CustomersList() {
  const { can, timezone: tz } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const tags = useTags();
  const [params, setParams] = useSearchParams();
  const [qInput, setQInput] = useState(params.get('q') ?? '');
  const q = useDebounced(qInput.trim(), 300);
  const [showFilters, setShowFilters] = useState(() =>
    ['tagId', 'lastVisitBefore', 'lastVisitAfter', 'future', 'bm'].some((k) => params.has(k)),
  );
  const [exporting, setExporting] = useState(false);

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const search: CustomerSearch = useMemo(
    () => ({
      q: q || undefined,
      tagId: params.get('tagId') || undefined,
      lastVisitBefore: params.get('lastVisitBefore') || undefined,
      lastVisitAfter: params.get('lastVisitAfter') || undefined,
      hasFutureAppointment:
        params.get('future') === 'yes' ? true : params.get('future') === 'no' ? false : undefined,
      birthdayMonth: params.get('bm') ? Number(params.get('bm')) : undefined,
      sort: (params.get('sort') as CustomerSearch['sort']) || 'last_visit',
      limit: 50,
    }),
    [q, params],
  );
  const result = useCustomerSearch(search);
  const items = result.data?.pages.flatMap((p) => p.items) ?? [];
  const activeFilters = ['tagId', 'lastVisitBefore', 'lastVisitAfter', 'future', 'bm'].filter((k) =>
    params.get(k),
  ).length;

  const exportCsv = async () => {
    setExporting(true);
    try {
      await customersApi.exportCsv(search);
      toast.success('CSVをダウンロードしました', 'エクスポートは監査ログに記録されます');
    } catch (e) {
      toast.error(e);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="顧客"
        description="氏名・フリガナ・電話番号で検索できます。店舗の権限範囲内の顧客が表示されます。"
        actions={
          <>
            {can('customer.merge') ? (
              <ButtonLink to="/app/customers/duplicates" icon="merge" variant="ghost">
                名寄せ
              </ButtonLink>
            ) : null}
            {can('export.data') ? (
              <Button icon="download" onClick={exportCsv} loading={exporting}>
                CSV出力
              </Button>
            ) : null}
            {can('customer.write') ? (
              <ButtonLink to="/app/customers/new" variant="primary" icon="plus">
                新規登録
              </ButtonLink>
            ) : null}
          </>
        }
      />

      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-[16rem] flex-1">
            <label htmlFor="customer-q" className="sr-only">
              顧客を検索
            </label>
            <Input
              id="customer-q"
              type="search"
              value={qInput}
              onChange={(e) => {
                setQInput(e.target.value);
                set('q', e.target.value.trim());
              }}
              placeholder="山田 / ヤマダ / 090-1234-5678"
              leading={<Icon name="search" size={16} />}
            />
          </div>
          <div className="w-52">
            <label htmlFor="customer-sort" className="sr-only">
              並び順
            </label>
            <Select
              id="customer-sort"
              value={search.sort}
              onChange={(e) => set('sort', e.target.value === 'last_visit' ? '' : e.target.value)}
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
          <Button
            icon="filter"
            variant={showFilters || activeFilters ? 'soft' : 'secondary'}
            onClick={() => setShowFilters((v) => !v)}
            aria-expanded={showFilters}
            aria-controls="customer-filters"
          >
            絞り込み{activeFilters ? `（${activeFilters}）` : ''}
          </Button>
        </div>
        {showFilters ? (
          <div
            id="customer-filters"
            className="grid gap-3 rounded-2xl border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-5"
          >
            <Field label="タグ">
              <Select
                value={params.get('tagId') ?? ''}
                onChange={(e) => set('tagId', e.target.value)}
              >
                <option value="">すべて</option>
                {(tags.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}（{t.customer_count ?? 0}）
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="最終来店（この日以降）">
              <Input
                type="date"
                value={params.get('lastVisitAfter') ?? ''}
                onChange={(e) => set('lastVisitAfter', e.target.value)}
              />
            </Field>
            <Field label="最終来店（この日より前）">
              <Input
                type="date"
                value={params.get('lastVisitBefore') ?? ''}
                onChange={(e) => set('lastVisitBefore', e.target.value)}
              />
            </Field>
            <Field label="次回予約">
              <Select
                value={params.get('future') ?? ''}
                onChange={(e) => set('future', e.target.value)}
              >
                <option value="">指定なし</option>
                <option value="yes">あり</option>
                <option value="no">なし</option>
              </Select>
            </Field>
            <Field label="誕生月">
              <Select value={params.get('bm') ?? ''} onChange={(e) => set('bm', e.target.value)}>
                <option value="">指定なし</option>
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={String(i + 1)}>
                    {i + 1}月
                  </option>
                ))}
              </Select>
            </Field>
            {activeFilters ? (
              <div className="sm:col-span-2 lg:col-span-5">
                <Button
                  size="sm"
                  variant="ghost"
                  icon="x"
                  onClick={() => {
                    const next = new URLSearchParams(params);
                    ['tagId', 'lastVisitBefore', 'lastVisitAfter', 'future', 'bm'].forEach((k) =>
                      next.delete(k),
                    );
                    setParams(next, { replace: true });
                  }}
                >
                  絞り込みを解除
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {result.isLoading ? <InlineLoading /> : null}
      {result.error ? (
        <ErrorState error={result.error} onRetry={() => void result.refetch()} />
      ) : null}
      {result.data && !items.length ? (
        <EmptyState
          icon="users"
          title={
            q || activeFilters ? '条件に一致する顧客がいません' : '顧客がまだ登録されていません'
          }
          description={
            q || activeFilters
              ? '検索条件を変えてお試しください。'
              : '予約の登録時や「新規登録」から顧客を追加できます。'
          }
        />
      ) : null}
      {items.length ? (
        <>
          <Table caption="顧客一覧">
            <THead>
              <tr>
                <Th>氏名</Th>
                <Th>電話番号</Th>
                <Th>最終来店</Th>
                <Th className="text-right">来店</Th>
                <Th className="text-right">累計売上</Th>
                <Th>次回予約</Th>
                <Th>タグ</Th>
              </tr>
            </THead>
            <TBody>
              {items.map((c) => (
                <Tr key={c.id} interactive onClick={() => navigate(`/app/customers/${c.id}`)}>
                  <Td>
                    <a
                      href={`/app/customers/${c.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        navigate(`/app/customers/${c.id}`);
                      }}
                      className="font-medium text-fg hover:text-primary hover:underline"
                    >
                      {c.display_name || '（氏名未登録）'}
                    </a>
                    <p className="text-xs text-muted">
                      {`${c.last_name_kana} ${c.first_name_kana}`.trim()}
                    </p>
                  </Td>
                  <Td className="whitespace-nowrap tabular text-muted">{c.phone ?? '—'}</Td>
                  <Td className="whitespace-nowrap">
                    {c.last_visit_at ? (
                      <>
                        {formatDate(c.last_visit_at, tz, { weekday: false })}
                        <span className="block text-xs text-muted">
                          {formatRelativeDay(c.last_visit_at, tz)}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  <Td className="text-right tabular">{c.visit_count}回</Td>
                  <Td className="text-right tabular">{formatYen(c.total_sales)}</Td>
                  <Td className="whitespace-nowrap">
                    {c.next_appointment_at ? (
                      <Badge tone="primary">
                        {formatDate(c.next_appointment_at, tz, { year: false })}
                      </Badge>
                    ) : (
                      <span className="text-xs text-subtle">なし</span>
                    )}
                  </Td>
                  <Td>
                    <div className="flex max-w-[16rem] flex-wrap gap-1">
                      {c.tags.slice(0, 3).map((t) => (
                        <TagChip key={t.id} name={t.name} color={t.color} />
                      ))}
                      {c.tags.length > 3 ? (
                        <span className="text-xs text-muted">+{c.tags.length - 3}</span>
                      ) : null}
                    </div>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          <LoadMore
            hasMore={!!result.hasNextPage}
            loading={result.isFetchingNextPage}
            onClick={() => void result.fetchNextPage()}
            total={items.length}
          />
        </>
      ) : null}
    </div>
  );
}
