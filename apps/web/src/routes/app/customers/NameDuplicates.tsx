import { useQueryClient } from '@tanstack/react-query';
import { GitMerge, Link2, Phone, Search, Users, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  customerKeys,
  customersApi,
  type NameDuplicateCustomer,
  type NameDuplicateGroup,
} from '../../../api/customers';
import { Badge, Button, Card, CardContent, Input } from '../../../components/shad';
import { AlertDialog } from '../../../components/shad/alert-dialog';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';

const PAGE = 50;

interface MergeTarget {
  keep: NameDuplicateCustomer;
  merge: NameDuplicateCustomer;
  groupIndex: number;
}

/**
 * 名前重複候補: groups of records with the same name. Per group: link them as one person
 * (shared 会員番号, records stay), dismiss the group, or merge a record into the recommended one.
 */
export function NameDuplicates() {
  const qc = useQueryClient();
  const toast = useToast();
  const [groups, setGroups] = useState<NameDuplicateGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [searched, setSearched] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<MergeTarget | null>(null);
  const [merging, setMerging] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [dismissTarget, setDismissTarget] = useState<NameDuplicateGroup | null>(null);

  const refreshCounts = () => void qc.invalidateQueries({ queryKey: customerKeys.all });

  const load = useCallback(
    async (search: string) => {
      setLoading(true);
      try {
        const res = await customersApi.nameDuplicates({ search: search || undefined, limit: PAGE });
        setGroups(res.groups);
        setTotal(res.total);
      } catch (e) {
        toast.error('名前重複候補の取得に失敗しました', errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load('');
  }, [load]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const res = await customersApi.nameDuplicates({
        search: searched || undefined,
        limit: PAGE,
        offset: groups.length,
      });
      setGroups((prev) => [...prev, ...res.groups.filter((g) => !prev.some((p) => p.normalized_name === g.normalized_name))]);
      setTotal(res.total);
    } catch (e) {
      toast.error('名前重複候補の取得に失敗しました', errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const link = async (group: NameDuplicateGroup, index: number) => {
    setLinking(group.normalized_name);
    try {
      const res = await customersApi.linkMaster(group.customers.map((c) => c.id));
      setGroups((prev) =>
        prev.map((g, i) =>
          i === index ? { ...g, customers: g.customers.map((c) => ({ ...c, member_no: res.member_no })) } : g,
        ),
      );
      toast.success(`会員番号 ${res.member_no} に統合しました（カルテ等は各店舗に残ります）`);
      refreshCounts();
    } catch (e) {
      toast.error('会員番号の統合に失敗しました', errorMessage(e));
    } finally {
      setLinking(null);
    }
  };

  const merge = async () => {
    if (!mergeTarget) return;
    const target = mergeTarget;
    setMerging(true);
    try {
      await customersApi.merge(target.keep.id, target.merge.id);
      const group = groups[target.groupIndex];
      const left = group ? group.customers.filter((c) => c.id !== target.merge.id) : [];
      setGroups((prev) =>
        prev.flatMap((g, i) => {
          if (i !== target.groupIndex) return [g];
          return left.length < 2 ? [] : [{ ...g, customers: left }];
        }),
      );
      if (group && left.length < 2) setTotal((n) => n - 1);
      refreshCounts();
    } catch (e) {
      toast.error('統合に失敗しました', errorMessage(e));
    } finally {
      setMerging(false);
      setMergeTarget(null);
    }
  };

  const dismiss = async () => {
    if (!dismissTarget) return;
    const target = dismissTarget;
    setDismissing(target.normalized_name);
    try {
      await customersApi.dismissNameDuplicate(target.normalized_name);
      setGroups((prev) => prev.filter((g) => g.normalized_name !== target.normalized_name));
      setTotal((n) => n - 1);
      refreshCounts();
    } catch (e) {
      toast.error('スキップに失敗しました', errorMessage(e));
    } finally {
      setDismissing(null);
      setDismissTarget(null);
    }
  };

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    setSearched(searchInput);
    void load(searchInput);
  };

  if (loading && groups.length === 0) {
    return <div className="py-12 text-center text-muted-foreground">読み込み中...</div>;
  }
  if (groups.length === 0 && !searched && !loading) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <Users className="mx-auto mb-2 h-12 w-12 opacity-50" />
        <p>名前重複の候補はありません</p>
      </div>
    );
  }

  const withStore = (c: NameDuplicateCustomer) => (c.store_name ? `（${c.store_name}）` : '');

  return (
    <>
      <div className="sy-4">
        <form className="flex gap-2" onSubmit={onSearch}>
          <Input
            placeholder="名前、電話番号で絞り込み..."
            aria-label="名前、電話番号で絞り込み"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" variant="outline" size="icon" className="shrink-0" disabled={loading} aria-label="絞り込む">
            <Search className="h-4 w-4" />
          </Button>
        </form>
        <div className="text-sm text-muted-foreground">
          {groups.length}/{total}グループ
        </div>
        {groups.length === 0 && searched && !loading ? (
          <div className="py-8 text-center text-muted-foreground">該当するグループがありません</div>
        ) : null}
        {groups.map((group, index) => (
          <Card key={group.normalized_name} data-name-duplicate={group.normalized_name}>
            <CardContent className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{group.customers[0]?.name || group.normalized_name}</Badge>
                  <span className="text-xs text-muted-foreground">{group.customers.length}件</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => void link(group, index)}
                    disabled={linking === group.normalized_name}
                  >
                    <Link2 className="mr-1 h-3 w-3" />
                    {linking === group.normalized_name ? '処理中...' : '同一人物としてリンク'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-muted-foreground"
                    onClick={() => setDismissTarget(group)}
                    disabled={dismissing === group.normalized_name}
                  >
                    <X className="mr-1 h-3 w-3" />
                    {dismissing === group.normalized_name ? '処理中...' : '統合しない'}
                  </Button>
                </div>
              </div>
              <div className="sy-2">
                {group.customers.map((c, i) => (
                  <div key={c.id} className="flex items-center justify-between rounded-md border p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{c.name}</span>
                        {c.name_kana ? <span className="text-xs text-muted-foreground">({c.name_kana})</span> : null}
                        {i === 0 ? (
                          <Badge variant="outline" className="border-green-400 text-[10px] text-green-600">
                            推奨
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        {c.phone ? (
                          <span className="flex items-center gap-1">
                            <Phone className="h-3 w-3" />
                            {c.phone}
                          </span>
                        ) : (
                          <span className="text-yellow-600">電話番号なし</span>
                        )}
                        {c.store_name ? <span>店舗: {c.store_name}</span> : null}
                        {c.staff_name ? <span>担当: {c.staff_name}</span> : null}
                        <span>来店{c.visit_count}回</span>
                        {c.member_no ? <span className="font-mono">{c.member_no}</span> : null}
                      </div>
                    </div>
                    {i > 0 ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="ml-2 shrink-0"
                        onClick={() => setMergeTarget({ keep: group.customers[0]!, merge: c, groupIndex: index })}
                      >
                        <GitMerge className="mr-1 h-3 w-3" />
                        統合
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
        {groups.length < total ? (
          <div className="pt-2 text-center">
            <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore} className="w-full">
              {loadingMore ? '読み込み中...' : `もっと見る（残り${total - groups.length}グループ）`}
            </Button>
          </div>
        ) : null}
      </div>

      <AlertDialog
        open={!!mergeTarget}
        onOpenChange={(open) => !open && setMergeTarget(null)}
        title="顧客情報を統合しますか？"
        description={
          mergeTarget ? (
            <>
              「{mergeTarget.merge.name}」{withStore(mergeTarget.merge)}の予約・カルテ・メッセージを 「
              {mergeTarget.keep.name}」{withStore(mergeTarget.keep)}に統合し、重複レコードを削除します。
              <br />
              <br />
              この操作は取り消せません。
            </>
          ) : null
        }
        actionLabel={merging ? '統合中...' : '統合する'}
        onAction={() => void merge()}
        busy={merging}
      />
      <AlertDialog
        open={!!dismissTarget}
        onOpenChange={(open) => !open && setDismissTarget(null)}
        title="統合しないとしてスキップしますか？"
        description={
          dismissTarget ? (
            <>
              「{dismissTarget.customers.map((c) => c.name).join('」「')}」
              を重複候補から除外します。今後この組み合わせは表示されません。
            </>
          ) : null
        }
        actionLabel={dismissTarget && dismissing === dismissTarget.normalized_name ? '処理中...' : 'スキップする'}
        onAction={() => void dismiss()}
        busy={!!dismissTarget && dismissing === dismissTarget.normalized_name}
      />
    </>
  );
}
