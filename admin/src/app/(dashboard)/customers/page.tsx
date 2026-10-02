"use client";

import { Suspense } from "react";
import { useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Plus, Search, Users, UserX, ChevronLeft, ChevronRight, GitMerge, Copy } from "lucide-react";
import { customers, mergeCandidates as mergeCandidatesApi, staff as staffApi, type Customer, type Staff } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { useStore } from "@/contexts/store-context";
import CustomerDetail from "./customer-detail";
import MergeCandidates from "./merge-candidates";
import NameDuplicates from "./name-duplicates";


function CustomersContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const isSelectMode = searchParams.get("mode") === "select";
  const detailId = searchParams.get("id");
  const staffIdParam = searchParams.get("staff_id");
  const { currentStore } = useStore();

  const [customerList, setCustomerList] = useState<Customer[]>([]);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [search, setSearch] = useState("");
  const [selectedStaff, setSelectedStaff] = useState<string>(staffIdParam || "all");
  const [tab, setTab] = useState("all");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [mergeCount, setMergeCount] = useState(0);
  const [nameDupCount, setNameDupCount] = useState(0);
  const [total, setTotal] = useState(0);
  const PAGE_SIZE = 50;


  useEffect(() => {
    if (!currentStore) return;
    staffApi.list().then(({ staff }) => setStaffList(staff)).catch(console.error);
    mergeCandidatesApi.count(currentStore.id)
      .then((data) => setMergeCount(data.count))
      .catch(() => {});
    customers.nameDuplicates()
      .then((data) => setNameDupCount(data.total))
      .catch(() => {});
  }, [currentStore?.id]);

  const fetchCustomers = useCallback(async () => {
    if (detailId) return;
    setLoading(true);
    try {
      const params: { search?: string; staff_id?: string; unassigned?: boolean; limit?: number } = {
        limit: PAGE_SIZE,
      };
      if (search) params.search = search;
      if (tab === "unassigned") {
        params.unassigned = true;
      } else if (selectedStaff !== "all") {
        params.staff_id = selectedStaff;
      }
      const { customers: data, total: t } = await customers.list(params);
      setCustomerList(data);
      setTotal(t);
    } catch (error) {
      console.error("Failed to fetch customers:", error);
    } finally {
      setLoading(false);
    }
  }, [search, selectedStaff, tab, detailId]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const params: { search?: string; staff_id?: string; unassigned?: boolean; limit?: number; offset?: number } = {
        limit: PAGE_SIZE,
        offset: customerList.length,
      };
      if (search) params.search = search;
      if (tab === "unassigned") {
        params.unassigned = true;
      } else if (selectedStaff !== "all") {
        params.staff_id = selectedStaff;
      }
      const { customers: data, total: t } = await customers.list(params);
      setCustomerList(prev => [...prev, ...data]);
      setTotal(t);
    } catch (error) {
      console.error("Failed to load more:", error);
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    const timeoutId = setTimeout(fetchCustomers, search ? 300 : 0);
    return () => clearTimeout(timeoutId);
  }, [fetchCustomers, search]);

  // Show detail view when id is in query params
  if (detailId) {
    return <CustomerDetail id={detailId} />;
  }

  const hasMore = customerList.length < total;
  const unassignedCount = tab === "unassigned" ? total : 0;


  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
          {isSelectMode && (
            <Button variant="ghost" size="icon" onClick={() => router.back()}>
              <ChevronLeft className="h-5 w-5" />
            </Button>
          )}
          {isSelectMode ? "顧客を選択" : "顧客管理"}
        </h1>
        <Button onClick={() => router.push(isSelectMode ? "/customers/new?mode=select" : "/customers/new")} size="sm" className="md:size-default">
          <Plus className="mr-1 md:mr-2 h-4 w-4" />
          <span className="hidden sm:inline">新規顧客</span>
          <span className="sm:hidden">追加</span>
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="py-3 md:py-4">
          <div className="space-y-3 md:space-y-0 md:flex md:flex-row md:items-center md:gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="名前、電話番号で検索..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10" />
            </div>
            <div className="flex items-center gap-2">
              <Tabs value={tab} onValueChange={setTab} className="flex-1 md:flex-none">
                <TabsList className="w-full md:w-auto">
                  <TabsTrigger value="all" className="flex-1 md:flex-none text-xs md:text-sm">
                    <Users className="mr-1 md:mr-2 h-3 w-3 md:h-4 md:w-4" />全顧客
                  </TabsTrigger>
                  <TabsTrigger value="unassigned" className="flex-1 md:flex-none text-xs md:text-sm">
                    <UserX className="mr-1 md:mr-2 h-3 w-3 md:h-4 md:w-4" />
                    <span className="hidden sm:inline">担当</span>未設定
                    {unassignedCount > 0 && <Badge variant="destructive" className="ml-1 md:ml-2 text-xs">{unassignedCount}</Badge>}
                  </TabsTrigger>
                  {mergeCount > 0 && (
                    <TabsTrigger value="merge" className="flex-1 md:flex-none text-xs md:text-sm">
                      <GitMerge className="mr-1 md:mr-2 h-3 w-3 md:h-4 md:w-4" />
                      統合候補
                      <Badge variant="destructive" className="ml-1 md:ml-2 text-xs">{mergeCount}</Badge>
                    </TabsTrigger>
                  )}
                  {nameDupCount > 0 && (
                    <TabsTrigger value="name-dup" className="flex-1 md:flex-none text-xs md:text-sm">
                      <Copy className="mr-1 md:mr-2 h-3 w-3 md:h-4 md:w-4" />
                      名前重複
                      <Badge variant="destructive" className="ml-1 md:ml-2 text-xs">{nameDupCount}</Badge>
                    </TabsTrigger>
                  )}
                </TabsList>
              </Tabs>
              {tab === "all" && (
                <Select value={selectedStaff} onValueChange={setSelectedStaff}>
                  <SelectTrigger className="w-[100px] md:w-[180px]"><SelectValue placeholder="担当" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全スタッフ</SelectItem>
                    {staffList.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Merge Candidates / Name Duplicates / Customer List */}
      {tab === "merge" ? (
        <Card>
          <CardHeader className="py-3 md:py-6">
            <CardTitle className="text-base md:text-lg">統合候補</CardTitle>
          </CardHeader>
          <CardContent>
            <MergeCandidates />
          </CardContent>
        </Card>
      ) : tab === "name-dup" ? (
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
            顧客一覧<span className="ml-2 text-sm md:text-base font-normal text-muted-foreground">({customerList.length}/{total}件)</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-8 text-center text-muted-foreground">読み込み中...</div>
          ) : customerList.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">顧客が見つかりません</div>
          ) : (
            <div className="space-y-2">
              {customerList.map((customer) => (
                <div
                  key={customer.id}
                  onClick={() => {
                    if (isSelectMode) {
                      router.push(`/reservations/new?customer_id=${customer.id}&customer_name=${encodeURIComponent(customer.name)}`);
                    } else {
                      router.push(`/customers?id=${customer.id}`);
                    }
                  }}
                  className="rounded-lg border p-3 md:p-4 transition-colors hover:bg-accent cursor-pointer"
                >
                  {/* モバイル */}
                  <div className="flex items-center gap-3 md:hidden">
                    <Avatar className="h-10 w-10 shrink-0"><AvatarFallback>{customer.name.charAt(0)}</AvatarFallback></Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-medium truncate">{customer.name}</span>
                        {customer.has_line === 1 && <svg className="shrink-0 h-4 w-4" viewBox="0 0 24 24" fill="#06C755"><path d="M12 2C6.48 2 2 5.83 2 10.5c0 4.08 3.42 7.5 8.05 8.35.31.07.74.21.85.48.1.25.07.63.03.88l-.14.82c-.04.25-.2.97.85.53s5.61-3.3 7.65-5.65C21.22 13.78 22 12.2 22 10.5 22 5.83 17.52 2 12 2z"/></svg>}
                        {customer.origin === "staff" && <Badge variant="outline" className="shrink-0 text-[10px] px-1 py-0 border-blue-400 text-blue-600">個人</Badge>}
                      </div>
                      {customer.name_kana && <div className="text-xs text-muted-foreground truncate">{customer.name_kana}</div>}
                      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                        {customer.phone && <span>{customer.phone}</span>}
                        <span>・来店{customer.visit_count}回</span>
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </div>
                  {/* デスクトップ */}
                  <div className="hidden md:flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <Avatar><AvatarFallback>{customer.name.charAt(0)}</AvatarFallback></Avatar>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{customer.name}</span>
                          {customer.has_line === 1 && <svg className="h-4 w-4" viewBox="0 0 24 24" fill="#06C755"><path d="M12 2C6.48 2 2 5.83 2 10.5c0 4.08 3.42 7.5 8.05 8.35.31.07.74.21.85.48.1.25.07.63.03.88l-.14.82c-.04.25-.2.97.85.53s5.61-3.3 7.65-5.65C21.22 13.78 22 12.2 22 10.5 22 5.83 17.52 2 12 2z"/></svg>}
                          {customer.name_kana && <span className="text-sm text-muted-foreground">({customer.name_kana})</span>}
                          {customer.origin === "staff" && <Badge variant="outline" className="text-xs border-blue-400 text-blue-600">スタッフ集客</Badge>}
                        </div>
                        <div className="flex items-center gap-4 text-sm text-muted-foreground">
                          {customer.phone && <span>{customer.phone}</span>}
                          {customer.email && <span>{customer.email}</span>}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right text-sm">
                        <div>来店 {customer.visit_count}回</div>
                        {customer.last_visit_at && <div className="text-muted-foreground">最終: {formatDate(customer.last_visit_at, "date")}</div>}
                      </div>
                      {(customer.staff_names || customer.staff_name) ? (
                        <Badge variant="secondary">担当: {customer.staff_names || customer.staff_name}</Badge>
                      ) : (
                        <Badge variant="outline" className="border-yellow-500 text-yellow-600">担当未設定</Badge>
                      )}
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                </div>
              ))}
              {hasMore && (
                <div className="pt-4 text-center">
                  <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? "読み込み中..." : `もっと見る（残り${total - customerList.length}件）`}
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      )}

    </div>
  );
}

export default function CustomersPage() {
  return (
    <Suspense fallback={<div className="py-12 text-center text-muted-foreground">読み込み中...</div>}>
      <CustomersContent />
    </Suspense>
  );
}
