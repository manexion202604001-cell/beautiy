"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Phone, GitMerge, Users, Search, X, Link2 } from "lucide-react";
import { customers, type Customer, type NameDuplicateGroup } from "@/lib/api";
import { useStore } from "@/contexts/store-context";

const PAGE_SIZE = 50;

export default function NameDuplicates() {
  const { currentStore } = useStore();
  const [groups, setGroups] = useState<NameDuplicateGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<{
    keep: Customer & { store_name?: string };
    merge: Customer & { store_name?: string };
    groupIndex: number;
  } | null>(null);
  const [processing, setProcessing] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [dismissTarget, setDismissTarget] = useState<NameDuplicateGroup | null>(null);

  const [appliedSearch, setAppliedSearch] = useState("");

  const fetchGroups = useCallback(async (searchVal: string) => {
    setLoading(true);
    try {
      const data = await customers.nameDuplicates({
        search: searchVal || undefined,
        limit: PAGE_SIZE,
      });
      setGroups(data.groups);
      setTotal(data.total);
    } catch (error) {
      console.error("Failed to fetch name duplicates:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGroups("");
  }, [fetchGroups]);

  const handleSearch = () => {
    setAppliedSearch(search);
    fetchGroups(search);
  };

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const data = await customers.nameDuplicates({
        search: search || undefined,
        limit: PAGE_SIZE,
        offset: groups.length,
      });
      setGroups(prev => [...prev, ...data.groups]);
      setTotal(data.total);
    } catch (error) {
      console.error("Failed to load more:", error);
    } finally {
      setLoadingMore(false);
    }
  };

  const handleLinkMaster = async (group: NameDuplicateGroup, groupIndex: number) => {
    setLinking(group.normalized_name);
    try {
      const res = await customers.linkMaster(group.customers.map((c) => c.id));
      setGroups((prev) => {
        const updated = [...prev];
        const g = updated[groupIndex];
        if (g) g.customers = g.customers.map((c) => ({ ...c, member_no: res.member_no }));
        return updated;
      });
      alert(`会員番号 ${res.member_no} に統合しました（カルテ等は各店舗に残ります）`);
    } catch (error) {
      console.error("Failed to link master:", error);
      alert("会員番号の統合に失敗しました");
    } finally {
      setLinking(null);
    }
  };

  const handleMerge = async () => {
    if (!mergeTarget) return;
    setProcessing(true);
    try {
      await customers.merge(mergeTarget.keep.id, mergeTarget.merge.id);
      setGroups(prev => {
        const updated = [...prev];
        const group = updated[mergeTarget.groupIndex];
        if (group) {
          group.customers = group.customers.filter(c => c.id !== mergeTarget.merge.id);
          if (group.customers.length < 2) {
            updated.splice(mergeTarget.groupIndex, 1);
            setTotal(t => t - 1);
          }
        }
        return updated;
      });
    } catch (error) {
      console.error("Failed to merge:", error);
      alert("統合に失敗しました");
    } finally {
      setProcessing(false);
      setMergeTarget(null);
    }
  };

  const handleDismiss = async () => {
    if (!currentStore || !dismissTarget) return;
    setDismissing(dismissTarget.normalized_name);
    try {
      await customers.dismissNameDuplicate(currentStore.id, dismissTarget.normalized_name);
      setGroups(prev => prev.filter(g => g.normalized_name !== dismissTarget.normalized_name));
      setTotal(t => t - 1);
    } catch (error) {
      console.error("Failed to dismiss:", error);
      alert("スキップに失敗しました");
    } finally {
      setDismissing(null);
      setDismissTarget(null);
    }
  };

  if (loading && groups.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        読み込み中...
      </div>
    );
  }

  if (groups.length === 0 && !appliedSearch && !loading) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <Users className="mx-auto h-12 w-12 mb-2 opacity-50" />
        <p>名前重複の候補はありません</p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); handleSearch(); }}>
          <Input
            placeholder="名前、電話番号で絞り込み..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" variant="outline" size="icon" className="shrink-0" disabled={loading}>
            <Search className="h-4 w-4" />
          </Button>
        </form>
        <div className="text-sm text-muted-foreground">
          {groups.length}/{total}グループ
        </div>
        {groups.length === 0 && appliedSearch && !loading && (
          <div className="py-8 text-center text-muted-foreground">
            該当するグループがありません
          </div>
        )}
        {groups.map((group, groupIndex) => (
          <Card key={group.normalized_name}>
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
                    className="text-xs h-7"
                    onClick={() => handleLinkMaster(group, groupIndex)}
                    disabled={linking === group.normalized_name}
                  >
                    <Link2 className="mr-1 h-3 w-3" />
                    {linking === group.normalized_name ? "処理中..." : "同一人物としてリンク"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-muted-foreground h-7"
                    onClick={() => setDismissTarget(group)}
                    disabled={dismissing === group.normalized_name}
                  >
                    <X className="mr-1 h-3 w-3" />
                    {dismissing === group.normalized_name ? "処理中..." : "統合しない"}
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                {group.customers.map((customer, idx) => (
                  <div
                    key={customer.id}
                    className="flex items-center justify-between rounded-md border p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{customer.name}</span>
                        {customer.name_kana && (
                          <span className="text-xs text-muted-foreground">({customer.name_kana})</span>
                        )}
                        {idx === 0 && (
                          <Badge variant="outline" className="text-[10px] border-green-400 text-green-600">推奨</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                        {customer.phone ? (
                          <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{customer.phone}</span>
                        ) : (
                          <span className="text-yellow-600">電話番号なし</span>
                        )}
                        {customer.store_name && <span>店舗: {customer.store_name}</span>}
                        {customer.staff_name && <span>担当: {customer.staff_name}</span>}
                        <span>来店{customer.visit_count}回</span>
                        {customer.member_no && <span className="font-mono">{customer.member_no}</span>}
                      </div>
                    </div>
                    {idx > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0 ml-2"
                        onClick={() => setMergeTarget({
                          keep: group.customers[0],
                          merge: customer,
                          groupIndex,
                        })}
                      >
                        <GitMerge className="mr-1 h-3 w-3" />
                        統合
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
        {groups.length < total && (
          <div className="pt-2 text-center">
            <Button variant="outline" onClick={loadMore} disabled={loadingMore} className="w-full">
              {loadingMore ? "読み込み中..." : `もっと見る（残り${total - groups.length}グループ）`}
            </Button>
          </div>
        )}
      </div>

      <AlertDialog open={!!mergeTarget} onOpenChange={(open) => !open && setMergeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>顧客情報を統合しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              「{mergeTarget?.merge.name}」
              {mergeTarget?.merge.store_name && `（${mergeTarget.merge.store_name}）`}
              の予約・カルテ・メッセージを
              「{mergeTarget?.keep.name}」
              {mergeTarget?.keep.store_name && `（${mergeTarget.keep.store_name}）`}
              に統合し、重複レコードを削除します。
              <br /><br />
              この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={handleMerge} disabled={processing}>
              {processing ? "統合中..." : "統合する"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!dismissTarget} onOpenChange={(open) => !open && setDismissTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>統合しないとしてスキップしますか？</AlertDialogTitle>
            <AlertDialogDescription>
              「{dismissTarget?.customers.map(c => c.name).join("」「")}」
              を重複候補から除外します。今後この組み合わせは表示されません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={handleDismiss} disabled={dismissing === dismissTarget?.normalized_name}>
              {dismissing === dismissTarget?.normalized_name ? "処理中..." : "スキップする"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
