import { ChevronLeft, ChevronRight, Copy, GitMerge, Plus, Search, UserX, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { customersApi, useCustomerSearch } from '../../../api/customers';
import { useStaffList } from '../../../api/org';
import type { CustomerListItem } from '../../../api/types';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Select,
  Tabs,
} from '../../../components/shad';
import { useAuth } from '../../../lib/auth';
import { MergeCandidates, mergeCandidatesKey } from './MergeCandidates';
import { NameDuplicates } from './NameDuplicates';
import { LineIcon, formatWhen, isStaffOrigin } from './shared';

type Tab = 'all' | 'unassigned' | 'merge' | 'name-dup';

const kanaOf = (c: CustomerListItem) => `${c.last_name_kana ?? ''} ${c.first_name_kana ?? ''}`.trim();

/**
 * 顧客管理 (main menu): the customer list that opens a customer's record, with the staff filter
 * and the 担当未設定 / 統合候補 / 名前重複 tabs.
 * ?mode=select is the customer picker of the reservation form (顧客を選択): the picked customer is
 * handed back to /app/calendar/new.
 */
export default function Customers() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { timezone: tz, can } = useAuth();
  const selectMode = params.get('mode') === 'select';

  // ?q= opens the list already searched (links from other screens)
  const [searchInput, setSearchInput] = useState(params.get('q') ?? '');
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [staffId, setStaffId] = useState(params.get('staff_id') || 'all');
  const [tab, setTab] = useState<Tab>('all');

  useEffect(() => {
    if (!searchInput) {
      setSearch('');
      return;
    }
    const t = window.setTimeout(() => setSearch(searchInput), 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const canMerge = can('customer.merge');
  const staffQ = useStaffList({});
  const dupQ = useQuery({
    queryKey: mergeCandidatesKey,
    queryFn: () => customersApi.duplicatePairs(100),
    enabled: canMerge,
    staleTime: 60_000,
  });
  const nameDupQ = useQuery({
    queryKey: ['customers', 'name-duplicates', 'count'],
    queryFn: () => customersApi.nameDuplicates({ limit: 1 }),
    enabled: canMerge,
    staleTime: 60_000,
  });
  const mergeCount = dupQ.data?.length ?? 0;
  const nameDupCount = nameDupQ.data?.total ?? 0;

  const listTab = tab === 'unassigned' ? 'unassigned' : 'all';
  const listQ = useCustomerSearch(
    {
      q: search || undefined,
      ...(listTab === 'unassigned' ? { unassigned: true } : staffId !== 'all' ? { staffId } : {}),
      limit: 50,
    },
    tab === 'all' || tab === 'unassigned',
  );
  const customers = listQ.data?.pages.flatMap((p) => p.items) ?? [];
  const total = listQ.data?.pages[0]?.total ?? 0;

  // customers nobody is in charge of (same search); the picker only counts them on its own tab
  const unassignedQ = useQuery({
    queryKey: ['customers', 'unassigned-count', search],
    queryFn: () => customersApi.search({ q: search || undefined, unassigned: true, limit: 1 }),
    enabled: !selectMode,
    staleTime: 30_000,
  });
  const unassignedCount = selectMode ? (tab === 'unassigned' ? total : 0) : (unassignedQ.data?.total ?? 0);

  const open = (c: CustomerListItem) => {
    if (selectMode)
      navigate(`/app/calendar/new?customer_id=${c.id}&customer_name=${encodeURIComponent(c.display_name)}`);
    else navigate(`/app/customers/${c.id}`);
  };

  const unassignedLabel = selectMode ? '未定' : '未設定';

  return (
    <div className="sy-4 md:sy-6">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-xl font-bold md:text-2xl">
          {selectMode ? (
            <Button variant="ghost" size="icon" aria-label="戻る" onClick={() => navigate(-1)}>
              <ChevronLeft className="h-5 w-5" />
            </Button>
          ) : null}
          {selectMode ? '顧客を選択' : 'カルテ'}
        </h1>
        <Button size="sm" onClick={() => navigate(selectMode ? '/app/customers/new?mode=select' : '/app/customers/new')}>
          <Plus className="mr-1 h-4 w-4 md:mr-2" />
          <span className="hidden sm:inline">新規顧客</span>
          <span className="sm:hidden">追加</span>
        </Button>
      </div>

      <Card>
        <CardContent className="py-3 md:py-4">
          <div className="sy-3 md:flex md:flex-row md:items-center md:gap-4 md:sy-0">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="名前、電話番号で検索..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex items-center gap-2">
              <Tabs
                label="顧客の絞り込み"
                value={tab}
                onValueChange={setTab}
                className="flex-1 md:flex-none"
                listClassName="w-full md:w-auto"
                triggerClassName="flex-1 md:flex-none text-xs md:text-sm"
                items={[
                  {
                    value: 'all',
                    label: (
                      <>
                        <Users className="mr-1 h-3 w-3 md:mr-2 md:h-4 md:w-4" />
                        全顧客
                      </>
                    ),
                  },
                  {
                    value: 'unassigned',
                    label: (
                      <>
                        <UserX className="mr-1 h-3 w-3 md:mr-2 md:h-4 md:w-4" />
                        <span className="hidden sm:inline">担当</span>
                        {unassignedLabel}
                        {unassignedCount > 0 ? (
                          <Badge variant="destructive" className="ml-1 text-xs md:ml-2">
                            {unassignedCount}
                          </Badge>
                        ) : null}
                      </>
                    ),
                  },
                  ...(mergeCount > 0 || tab === 'merge'
                    ? [
                        {
                          value: 'merge' as const,
                          label: (
                            <>
                              <GitMerge className="mr-1 h-3 w-3 md:mr-2 md:h-4 md:w-4" />
                              統合候補
                              {mergeCount > 0 ? (
                                <Badge variant="destructive" className="ml-1 text-xs md:ml-2">
                                  {mergeCount}
                                </Badge>
                              ) : null}
                            </>
                          ),
                        },
                      ]
                    : []),
                  ...(nameDupCount > 0 || tab === 'name-dup'
                    ? [
                        {
                          value: 'name-dup' as const,
                          label: (
                            <>
                              <Copy className="mr-1 h-3 w-3 md:mr-2 md:h-4 md:w-4" />
                              名前重複
                              {nameDupCount > 0 ? (
                                <Badge variant="destructive" className="ml-1 text-xs md:ml-2">
                                  {nameDupCount}
                                </Badge>
                              ) : null}
                            </>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
              {tab === 'all' ? (
                <Select
                  label="担当"
                  value={staffId}
                  onValueChange={setStaffId}
                  placeholder="担当"
                  className="w-[100px] md:w-[180px]"
                  options={[
                    { value: 'all', label: '全スタッフ' },
                    ...(staffQ.data ?? []).map((s) => ({ value: s.id, label: s.display_name })),
                  ]}
                />
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      {tab === 'merge' ? (
        <Card>
          <CardHeader className="py-3 md:py-6">
            <CardTitle className="text-base md:text-lg">統合候補</CardTitle>
          </CardHeader>
          <CardContent>
            <MergeCandidates />
          </CardContent>
        </Card>
      ) : tab === 'name-dup' ? (
        <Card>
          <CardHeader className="py-3 md:py-6">
            <CardTitle className="text-base md:text-lg">名前重複候補</CardTitle>
          </CardHeader>
          <CardContent>
            <NameDuplicates />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="py-3 md:py-6">
            <CardTitle className="text-base md:text-lg">
              顧客一覧
              <span className="ml-2 text-sm font-normal text-muted-foreground md:text-base">
                {selectMode ? `(${customers.length}/${total}件)` : `(${total}件)`}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {listQ.isLoading ? (
              <div className="py-8 text-center text-muted-foreground">読み込み中...</div>
            ) : customers.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">顧客が見つかりません</div>
            ) : (
              <div className="sy-2">
                {customers.map((c) => {
                  const kana = kanaOf(c);
                  const staffOrigin = isStaffOrigin(c.acquisition_source);
                  // the picker also tells LINE friends apart; the 顧客管理 list does not
                  const lineName = selectMode && c.name_source === 'line';
                  const line = selectMode && c.has_line;
                  return (
                    <div
                      key={c.id}
                      data-customer={c.id}
                      onClick={() => open(c)}
                      className="cursor-pointer rounded-lg border p-3 transition-colors hover:bg-accent md:p-4"
                    >
                      <div className="flex items-center gap-3 md:hidden">
                        <Avatar name={c.display_name} className="h-10 w-10 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate font-medium">{c.display_name}</span>
                            {lineName ? (
                              <Badge variant="outline" className="shrink-0 border-amber-500 px-1 py-0 text-[10px] text-amber-600">
                                本名未登録
                              </Badge>
                            ) : null}
                            {line ? <LineIcon className="h-4 w-4 shrink-0" /> : null}
                            {staffOrigin ? (
                              <Badge variant="outline" className="shrink-0 border-blue-400 px-1 py-0 text-[10px] text-blue-600">
                                個人
                              </Badge>
                            ) : null}
                          </div>
                          {kana ? <div className="truncate text-xs text-muted-foreground">{kana}</div> : null}
                          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                            {c.phone ? <span>{c.phone}</span> : null}
                            <span>・来店{c.visit_count}回</span>
                          </div>
                        </div>
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </div>
                      <div className="hidden items-center justify-between md:flex">
                        <div className="flex items-center gap-4">
                          <Avatar name={c.display_name} />
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{c.display_name}</span>
                              {lineName ? (
                                <Badge variant="outline" className="border-amber-500 px-1 py-0 text-[10px] text-amber-600">
                                  本名未登録
                                </Badge>
                              ) : null}
                              {line ? <LineIcon className="h-4 w-4" /> : null}
                              {kana ? <span className="text-sm text-muted-foreground">({kana})</span> : null}
                              {staffOrigin ? (
                                <Badge variant="outline" className="border-blue-400 text-xs text-blue-600">
                                  スタッフ集客
                                </Badge>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-4 text-sm text-muted-foreground">
                              {c.phone ? <span>{c.phone}</span> : null}
                              {c.email ? <span>{c.email}</span> : null}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="text-right text-sm">
                            <div>来店 {c.visit_count}回</div>
                            {c.last_visit_at ? (
                              <div className="text-muted-foreground">最終: {formatWhen(c.last_visit_at, tz, 'date')}</div>
                            ) : null}
                          </div>
                          {c.primary_staff_name ? (
                            <Badge variant="secondary">担当: {c.primary_staff_name}</Badge>
                          ) : (
                            <Badge variant="outline" className="border-yellow-500 text-yellow-600">
                              担当{unassignedLabel}
                            </Badge>
                          )}
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </div>
                      </div>
                    </div>
                  );
                })}
                {listQ.hasNextPage ? (
                  <div className="pt-4 text-center">
                    <Button
                      variant="outline"
                      onClick={() => void listQ.fetchNextPage()}
                      disabled={listQ.isFetchingNextPage}
                    >
                      {listQ.isFetchingNextPage ? '読み込み中...' : `もっと見る（残り${total - customers.length}件）`}
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
