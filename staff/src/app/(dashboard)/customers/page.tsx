"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Search,
  Plus,
  Phone,
  ChevronLeft,
  ChevronRight,
  GitMerge,
} from "lucide-react";
import {
  customers,
  type Customer,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useStore } from "@/contexts/store-context";
import CustomerDetail from "./customer-detail";
import NameDuplicates from "./name-duplicates";

function CustomersContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const isSelectMode = searchParams.get("mode") === "select";
  const detailId = searchParams.get("id");
  const detailTab = searchParams.get("tab");
  const { currentStore } = useStore();

  // Tab state
  const [activeTab, setActiveTab] = useState<"list" | "merge">("list");
  const [dupCount, setDupCount] = useState(0);

  // List state
  const [customerList, setCustomerList] = useState<Customer[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);
  const PAGE_SIZE = 50;

  // Fetch customer list
  const fetchCustomers = useCallback(async () => {
    if (!currentStore || detailId) return;
    setLoading(true);
    try {
      const params: { search?: string; limit?: number } = { limit: PAGE_SIZE };
      if (search) params.search = search;
      const { customers: data, total: t } = await customers.list(params);
      setCustomerList(data);
      setTotal(t);
    } catch (error) {
      console.error("Failed to fetch customers:", error);
    } finally {
      setLoading(false);
    }
  }, [currentStore?.id, search, detailId]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const params: { search?: string; limit?: number; offset?: number } = {
        limit: PAGE_SIZE,
        offset: customerList.length,
      };
      if (search) params.search = search;
      const { customers: data, total: t } = await customers.list(params);
      setCustomerList(prev => [...prev, ...data]);
      setTotal(t);
    } catch (error) {
      console.error("Failed to load more:", error);
    } finally {
      setLoadingMore(false);
    }
  };

  // Debounced fetch on store or search change
  useEffect(() => {
    const timeoutId = setTimeout(fetchCustomers, search ? 300 : 0);
    return () => clearTimeout(timeoutId);
  }, [fetchCustomers, search]);

  // Fetch merge candidates count and name duplicates count
  useEffect(() => {
    if (!currentStore) return;
    customers.duplicates({ limit: 0 })
      .then((data) => setDupCount(data.total))
      .catch(() => {});
  }, [currentStore?.id]);

  // Show detail view when id is in query params
  if (detailId) {
    return <CustomerDetail id={detailId} defaultTab={(detailTab as "karutes" | "counseling") || "karutes"} backPath="/customers" />;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold flex items-center gap-2">
          {isSelectMode && (
            <Button variant="ghost" size="icon" onClick={() => router.back()}>
              <ChevronLeft className="h-5 w-5" />
            </Button>
          )}
          {isSelectMode ? "顧客を選択" : "顧客管理"}
        </h1>
        <Button onClick={() => router.push(isSelectMode ? "/customers/new?mode=select" : "/customers/new")} size="sm">
          <Plus className="mr-1 h-4 w-4" />
          {isSelectMode ? "新規顧客" : "新規登録"}
        </Button>
      </div>

      {/* Tabs */}
      {dupCount > 0 && !isSelectMode && (
        <div className="flex border-b">
          <button
            className={cn(
              "flex-1 py-2 text-sm font-medium border-b-2 transition-colors",
              activeTab === "list"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground"
            )}
            onClick={() => setActiveTab("list")}
          >
            顧客一覧
          </button>
          <button
            className={cn(
              "flex-1 py-2 text-sm font-medium border-b-2 transition-colors flex items-center justify-center gap-1.5",
              activeTab === "merge"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground"
            )}
            onClick={() => setActiveTab("merge")}
          >
            <GitMerge className="h-4 w-4" />
            統合候補
            <Badge variant="destructive" className="text-[10px] px-1.5 py-0 min-w-[1.25rem] h-5">
              {dupCount}
            </Badge>
          </button>
        </div>
      )}

      {activeTab === "merge" ? (
        <NameDuplicates />
      ) : (
        <>
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="名前、電話番号で検索..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10"
            />
          </div>

          {/* Customer list */}
          <div className="text-sm text-muted-foreground">
            {customerList.length}/{total}件の顧客
          </div>

          {loading ? (
            <div className="py-12 text-center text-muted-foreground">
              読み込み中...
            </div>
          ) : customerList.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              顧客が見つかりません
            </div>
          ) : (
            <div className="space-y-2">
              {customerList.map((customer) => (
                <Card
                  key={customer.id}
                  className="cursor-pointer transition-colors hover:bg-accent"
                  onClick={() => {
                    if (isSelectMode) {
                      router.push(`/reservations/new?customer_id=${customer.id}&customer_name=${encodeURIComponent(customer.name)}`);
                    } else {
                      router.push(`/customers?id=${customer.id}`);
                    }
                  }}
                >
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium truncate">{customer.name}</span>
                          {customer.has_line === 1 && <svg className="shrink-0 h-4 w-4" viewBox="0 0 24 24" fill="#06C755"><path d="M12 2C6.48 2 2 5.83 2 10.5c0 4.08 3.42 7.5 8.05 8.35.31.07.74.21.85.48.1.25.07.63.03.88l-.14.82c-.04.25-.2.97.85.53s5.61-3.3 7.65-5.65C21.22 13.78 22 12.2 22 10.5 22 5.83 17.52 2 12 2z"/></svg>}
                          {customer.origin === "staff" && (
                            <Badge variant="outline" className="shrink-0 text-[10px] px-1 py-0 border-blue-400 text-blue-600">個人</Badge>
                          )}
                        </div>
                        {customer.name_kana && (
                          <div className="text-xs text-muted-foreground truncate">
                            {customer.name_kana}
                          </div>
                        )}
                        {customer.phone && (
                          <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                            <Phone className="h-3 w-3" />
                            {customer.phone}
                          </div>
                        )}
                        <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
                          {customer.last_visit_date && (
                            <span>施術日: {customer.last_visit_date.replace(/-/g, "/")}</span>
                          )}
                          {customer.last_staff_nickname && (
                            <span>担当: {customer.last_staff_nickname}</span>
                          )}
                          {customer.store_name && (
                            <span>店舗: {customer.store_name}</span>
                          )}
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    </div>
                  </CardContent>
                </Card>
              ))}
              {customerList.length < total && (
                <div className="pt-4 text-center">
                  <Button variant="outline" onClick={loadMore} disabled={loadingMore} className="w-full">
                    {loadingMore ? "読み込み中..." : `もっと見る（残り${total - customerList.length}件）`}
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
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
