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
import { Phone, GitMerge, Users, Search, MessageCircle, CalendarDays, Link2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { customers, type Customer, type DuplicateGroup } from "@/lib/api";

const PAGE_SIZE = 50;

export default function NameDuplicates() {
  const router = useRouter();
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
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
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [appliedSearch, setAppliedSearch] = useState("");

  const fetchGroups = useCallback(async (searchVal: string) => {
    setLoading(true);
    try {
      const data = await customers.duplicates({
        search: searchVal || undefined,
        limit: PAGE_SIZE,
      });
      setGroups(data.groups);
      setTotal(data.total);
    } catch (error) {
      console.error("Failed to fetch duplicates:", error);
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
      const data = await customers.duplicates({
        search: appliedSearch || undefined,
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

  const handleLinkMaster = async (group: DuplicateGroup, groupIndex: number) => {
    setLinking(group.customers.map((c) => c.id).join("-"));
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
      const reason = error instanceof Error ? error.message : "";
      alert(reason ? `会員番号の統合に失敗しました：${reason}` : "会員番号の統合に失敗しました");
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
      const msg = (error instanceof Error && error.message) || "統合に失敗しました";
      setMergeError(msg);
    } finally {
      setProcessing(false);
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
        <p>統合候補はありません</p>
      </div>
    );
  }

  const reasonColor: Record<string, string> = {
    "名前一致": "bg-blue-100 text-blue-700",
    "電話番号一致": "bg-green-100 text-green-700",
    "LINE一致": "bg-emerald-100 text-emerald-700",
  };

  return (
    <>
      <div className="space-y-3">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); handleSearch(); }}>
          <Input
            placeholder="名前、電話番号、店舗名で検索..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" variant="outline" size="icon" className="shrink-0" disabled={loading}>
            <Search className="h-4 w-4" />
          </Button>
        </form>
        <div className="text-xs text-muted-foreground">
          {groups.length}/{total}グループ
        </div>
        {groups.length === 0 && appliedSearch && !loading && (
          <div className="py-8 text-center text-muted-foreground">
            該当するグループがありません
          </div>
        )}
        {groups.map((group, groupIndex) => (
          <Card key={group.customers.map(c => c.id).join("-")}>
            <CardContent className="p-3">
              <div className="mb-2 flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium">{group.customers[0]?.name}</span>
                  <span className="text-xs text-muted-foreground">{group.customers.length}件</span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs shrink-0"
                  onClick={() => handleLinkMaster(group, groupIndex)}
                  disabled={linking === group.customers.map((c) => c.id).join("-")}
                >
                  <Link2 className="mr-1 h-3 w-3" />
                  {linking === group.customers.map((c) => c.id).join("-") ? "処理中..." : "同一人物としてリンク"}
                </Button>
              </div>
              <div className="space-y-2">
                {group.customers.map((customer, idx) => {
                  const reasons: string[] = customer.match_reasons || [];
                  const resCount: number = customer.reservation_count || 0;
                  return (
                  <div
                    key={customer.id}
                    className="flex items-center justify-between rounded-md border p-2.5 cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => router.push(`/customers?id=${customer.id}`)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-medium text-sm">{customer.name}</span>
                        {customer.name_kana && (
                          <span className="text-[10px] text-muted-foreground">({customer.name_kana})</span>
                        )}
                        {idx === 0 && (
                          <Badge variant="outline" className="text-[10px] px-1 py-0 border-green-400 text-green-600">推奨</Badge>
                        )}
                        {reasons.map(r => (
                          <Badge key={r} variant="secondary" className={`text-[10px] px-1 py-0 ${reasonColor[r] || ""}`}>
                            {r}
                          </Badge>
                        ))}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground flex-wrap">
                        {customer.phone ? (
                          <span className="flex items-center gap-0.5"><Phone className="h-3 w-3" />{customer.phone}</span>
                        ) : (
                          <span className="text-yellow-600">電話番号なし</span>
                        )}
                        {customer.line_user_id && (
                          <span className="flex items-center gap-0.5 text-green-600"><MessageCircle className="h-3 w-3" />LINE</span>
                        )}
                        {customer.store_name && <span>{customer.store_name}</span>}
                        {customer.staff_name && <span>担当:{customer.staff_name}</span>}
                        <span>来店{customer.visit_count || 0}回</span>
                        {customer.member_no && <span className="font-mono">{customer.member_no}</span>}
                        {resCount > 0 ? (
                          <span className="flex items-center gap-0.5 text-blue-600"><CalendarDays className="h-3 w-3" />予約{resCount}件</span>
                        ) : (
                          <span className="text-gray-400">予約なし</span>
                        )}
                      </div>
                    </div>
                    {idx > 0 && (
                      // Physical merge now supports cross-store: the person is consolidated into
                      // one record, while per-store data (karutes/reservations/messages/LINE) keeps
                      // its own store. 会員番号リンク (group button above) remains for a non-destructive option.
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0 ml-2 h-7 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMergeTarget({
                            keep: group.customers[0],
                            merge: customer,
                            groupIndex,
                          });
                        }}
                      >
                        <GitMerge className="mr-1 h-3 w-3" />
                        統合
                      </Button>
                    )}
                  </div>
                  );
                })}
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

      <AlertDialog open={!!mergeTarget} onOpenChange={(open) => { if (!open) { setMergeTarget(null); setMergeError(null); } }}>
        <AlertDialogContent className="w-[calc(100vw-2rem)]">
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
          {mergeError && (
            <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
              {mergeError}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={handleMerge} disabled={processing}>
              {processing ? "統合中..." : "統合する"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
