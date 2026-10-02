"use client";

import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Store, ChevronRight, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reservations, type Reservation } from "@/lib/api";
import { formatDate, formatPrice } from "@/lib/utils";
import { useStore } from "@/contexts/store-context";
import { isPushSupported, subscribePush, isSubscribed, getPermissionState } from "@/lib/push-notifications";

type TabValue = "reservations" | "pending" | "cancelled";

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const { currentStore, staff } = useStore();
  const [tab, setTab] = useState<TabValue>("reservations");
  const [showAll, setShowAll] = useState(false);
  const [todayOnly, setTodayOnly] = useState(false);
  const [sortBy, setSortBy] = useState<"date" | "newest">("date");
  const [allReservations, setAllReservations] = useState<Reservation[]>([]);
  const [pendingReservations, setPendingReservations] = useState<Reservation[]>([]);
  const [cancelledReservations, setCancelledReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showPushBanner, setShowPushBanner] = useState(false);
  const [subscribing, setSubscribing] = useState(false);

  const canToggleScope = !!staff;

  // 通知(highlight)から開かれた時: 該当予約が見えるようタブを切替。担当外でも見えるよう権限があれば店舗全体に。
  // useSearchParams を使い、アプリが既に開いている状態でURL(クエリ)が変わっても反応するようにする。
  useEffect(() => {
    const id = searchParams.get("highlight");
    const tabParam = searchParams.get("tab");
    if (id) {
      setHighlightId(id);
      setTab(tabParam === "cancel" ? "cancelled" : "reservations");
      if (staff) setShowAll(true);
    }
  }, [searchParams, staff]);

  // 該当予約までスクロール（予約・確定待ち・キャンセルのどのタブでも、データ読み込み後に発火）
  useEffect(() => {
    if (highlightId && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightId, allReservations, pendingReservations, cancelledReservations]);

  const buildParams = useCallback((extra: Record<string, string> = {}) => {
    const params: Record<string, string> = { store_id: currentStore!.id, ...extra };
    if (!showAll && staff) {
      params.staff_id = staff.id;
    }
    return params;
  }, [currentStore?.id, showAll, staff?.id]);

  const fetchTabData = useCallback(async (activeTab: TabValue) => {
    if (!currentStore) return;
    setLoading(true);
    try {
      const today = new Date().toISOString().split("T")[0];

      if (activeTab === "reservations") {
        const resData = await reservations.list(buildParams({ start_date: today }));
        setAllReservations(
          resData.reservations
            .filter((r) => r.status !== "cancelled" && r.status !== "noshow")
            .sort(
              (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
            )
        );
      } else if (activeTab === "pending") {
        const resData = await reservations.list(buildParams({ status: "pending" }));
        setPendingReservations(
          resData.reservations.sort(
            (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
          )
        );
      } else if (activeTab === "cancelled") {
        const resData = await reservations.list(
          buildParams({ status: "cancelled", sort: "updated_at_desc", limit: "100" })
        );
        // API order = recently cancelled first; do not re-sort.
        setCancelledReservations(resData.reservations);
      }
    } catch (error) {
      console.error("Failed to fetch dashboard data:", error);
    } finally {
      setLoading(false);
    }
  }, [currentStore?.id, buildParams]);

  useEffect(() => {
    if (!currentStore) {
      setLoading(false);
      return;
    }
    fetchTabData(tab);
  }, [currentStore?.id, tab, showAll]);

  // 確定待ち件数は常に取得（タブバッジ＋確認待ちカードを、どのタブにいても正しく表示するため）
  useEffect(() => {
    if (!currentStore) return;
    reservations
      .list(buildParams({ status: "pending" }))
      .then((resData) =>
        setPendingReservations(
          resData.reservations.sort(
            (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
          )
        )
      )
      .catch(() => {});
  }, [currentStore?.id, showAll]);

  // Show push notification banner if not subscribed
  useEffect(() => {
    if (!staff) return;
    if (!isPushSupported()) return;
    if (getPermissionState() === "denied") return;
    isSubscribed().then((subscribed) => {
      if (!subscribed) setShowPushBanner(true);
    });
  }, [staff]);

  const handleEnablePush = async () => {
    setSubscribing(true);
    const success = await subscribePush();
    if (success) setShowPushBanner(false);
    setSubscribing(false);
  };

  const handleTabChange = (value: string) => {
    setTab(value as TabValue);
  };

  // 「本日に絞り込む」フィルタ
  const displayReservations = todayOnly
    ? allReservations.filter((r) => {
        const d = new Date(r.start_at);
        const t = new Date();
        return (
          d.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }) ===
          t.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })
        );
      })
    : allReservations;

  // 並び替え: 日付順(start_at昇順) / 新着順(created_at降順=最近予約された順)
  const sortedReservations = [...displayReservations].sort((a, b) => {
    if (sortBy === "newest") {
      return (
        new Date(b.created_at || b.start_at).getTime() -
        new Date(a.created_at || a.start_at).getTime()
      );
    }
    return new Date(a.start_at).getTime() - new Date(b.start_at).getTime();
  });

  const getStatusText = (status: Reservation["status"]) => {
    switch (status) {
      case "pending":
        return <span className="text-xs font-bold text-yellow-600">確認待ち</span>;
      case "confirmed":
        return <span className="text-xs font-bold text-green-600">確定</span>;
      case "completed":
        return <span className="text-xs text-muted-foreground">完了</span>;
      case "cancelled":
        return <span className="text-xs font-bold text-red-600">キャンセル</span>;
      case "noshow":
        return <span className="text-xs font-bold text-red-600">無断キャンセル</span>;
      default:
        return <span className="text-xs text-muted-foreground">{status}</span>;
    }
  };

  // 予約経路（source）ラベル＋色
  const getSourceBadge = (source: Reservation["source"]) => {
    switch (source) {
      case "line":
        return { label: "LINE", color: "#06C755" };
      case "hotpepper":
        return { label: "HPB", color: "#E50012" };
      case "minimo":
        return { label: "minimo", color: "#00A7FF" };
      case "phone":
        return { label: "電話", color: "#6b7280" };
      case "walk-in":
        return { label: "来店", color: "#f59e0b" };
      case "web":
        return { label: "Web", color: "#8b5cf6" };
      default:
        return { label: source, color: "#6b7280" };
    }
  };

  const renderReservationItem = (reservation: Reservation, showDate = false) => {
    const isCancelled = reservation.status === "cancelled";
    const sourceBadge = getSourceBadge(reservation.source);
    return (
    <div
      key={reservation.id}
      ref={reservation.id === highlightId ? highlightRef : undefined}
      className={`relative rounded-lg border p-4 cursor-pointer transition-colors hover:bg-muted/50 ${reservation.id === highlightId ? "ring-2 ring-primary border-primary bg-primary/5" : ""} ${isCancelled ? "opacity-70" : ""}`}
      onClick={() => router.push(`/reservations/${reservation.id}`)}
    >
      {/* 通知から開かれた予約: 新着バッジ - カード右肩 */}
      {reservation.id === highlightId && (
        <Badge className="absolute -top-2 -right-1 text-xs bg-red-500 hover:bg-red-500">新着</Badge>
      )}
      {/* カード左肩: キャンセル/新規バッジ ＋ 予約経路ラベル（同じライン） */}
      <div className="absolute -top-2 -left-1 flex items-center gap-1">
        {reservation.customer_visit_count === 0 ? (
          <Badge variant="success" className="text-xs">新規</Badge>
        ) : (
          <Badge variant="secondary" className="text-xs">再来</Badge>
        )}
        {reservation.is_nominated === 1 ? (
          <Badge className="text-xs text-white" style={{ backgroundColor: "#6366f1" }}>指名</Badge>
        ) : (
          <Badge variant="outline" className="text-xs bg-white">フリー</Badge>
        )}
        <Badge
          className="text-xs text-white hover:opacity-90"
          style={{ backgroundColor: sourceBadge.color }}
        >
          {sourceBadge.label}
        </Badge>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 min-w-0 flex-1">
          <div className="text-center min-w-[60px] shrink-0">
            {showDate && (
              <div className="text-xs text-muted-foreground">
                {new Date(reservation.start_at).toLocaleDateString("ja-JP", {
                  timeZone: "Asia/Tokyo",
                  month: "numeric",
                  day: "numeric",
                })}
              </div>
            )}
            <div className="text-lg font-bold">
              {formatDate(reservation.start_at, "time")}
            </div>
            <div className="text-xs text-muted-foreground">
              〜{formatDate(reservation.end_at, "time")}
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-medium truncate">
              {reservation.customer_name}
              {reservation.is_minimo === 1 && (
                <span className="ml-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium text-white" style={{ backgroundColor: "#00A7FF" }}>minimo</span>
              )}
            </div>
            <div className="text-sm text-muted-foreground truncate">
              {reservation.menu_name}
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{reservation.staff_nickname || reservation.staff_name || ""}</span>
              {getStatusText(reservation.status)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {reservation.price != null && (
            <div className="text-sm font-medium text-right hidden sm:block">
              {formatPrice(reservation.price)}
            </div>
          )}
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
    </div>
    );
  };

  if (loading && !allReservations.length && !pendingReservations.length && !cancelledReservations.length) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  if (!currentStore) {
    return (
      <div className="space-y-6">
        <div>
          {staff && (
            <h1 className="text-2xl font-bold">{staff.nickname || staff.name}さん、ようこそ</h1>
          )}
          <p className="text-muted-foreground">{formatDate(new Date(), "date")}</p>
        </div>
        <Card>
          <CardContent className="py-12 text-center">
            <Store className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h2 className="text-lg font-medium mb-2">店舗に所属していません</h2>
            <p className="text-sm text-muted-foreground mb-1">
              オーナーにスタッフID（{staff?.staff_code}）を伝えて招待を受けてください
            </p>
            <p className="text-xs text-muted-foreground">
              招待が届くとこの画面上部に表示されます
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {showPushBanner && (
        <div className="rounded-lg border bg-card p-3 text-sm">
          <div className="flex items-start gap-3">
            <Bell className="h-4 w-4 text-primary shrink-0 mt-0.5" />
            <span className="flex-1">プッシュ通知を有効にすると、新しい予約やメッセージが届いた時に通知を受け取れます。</span>
          </div>
          <div className="flex gap-2 justify-end mt-2">
            <Button size="sm" variant="ghost" onClick={() => setShowPushBanner(false)}>
              あとで
            </Button>
            <Button size="sm" onClick={handleEnablePush} disabled={subscribing}>
              {subscribing ? "設定中..." : "有効にする"}
            </Button>
          </div>
        </div>
      )}
      <div>
        {staff && (
          <h1 className="text-2xl font-bold">{staff.nickname || staff.name}さん、お疲れさまです</h1>
        )}
        <div className="flex items-center justify-between mt-1">
          <p className="text-muted-foreground">{formatDate(new Date(), "date")}</p>
          {canToggleScope && (
            <div className="flex rounded-lg border overflow-hidden">
              <button
                className={`px-4 py-1.5 text-sm font-medium transition-colors ${
                  !showAll ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
                onClick={() => setShowAll(false)}
              >
                自分
              </button>
              <button
                className={`px-4 py-1.5 text-sm font-medium transition-colors border-l ${
                  showAll ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
                onClick={() => setShowAll(true)}
              >
                店舗
              </button>
            </div>
          )}
        </div>
      </div>

      <Tabs value={tab} onValueChange={handleTabChange}>
        <TabsList className="w-full">
          <TabsTrigger value="reservations" className="flex-1">予約</TabsTrigger>
          <TabsTrigger value="pending" className="flex-1">
            確定待ち
            {pendingReservations.length > 0 && tab !== "pending" && (
              <span className="ml-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-[10px] text-destructive-foreground">
                {pendingReservations.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="cancelled" className="flex-1">キャンセル</TabsTrigger>
        </TabsList>

        {/* Reservations Tab */}
        <TabsContent value="reservations" className="mt-4 space-y-4">
          <div className="flex justify-between items-center gap-2">
            {/* 並び替え: 日付順 / 新着順 */}
            <div className="flex rounded-lg border overflow-hidden">
              <button
                className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                  sortBy === "date" ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
                onClick={() => setSortBy("date")}
              >
                日付順
              </button>
              <button
                className={`px-3 py-1.5 text-sm font-medium transition-colors border-l ${
                  sortBy === "newest" ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
                onClick={() => setSortBy("newest")}
              >
                新着順
              </button>
            </div>
            <button
              className={`rounded-lg border px-4 py-1.5 text-sm font-medium transition-colors ${
                todayOnly ? "bg-primary text-primary-foreground" : "hover:bg-muted"
              }`}
              onClick={() => setTodayOnly((v) => !v)}
            >
              {todayOnly ? "すべて表示" : "本日のみ"}
            </button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>予約一覧</CardTitle>
              <CardDescription>
                {displayReservations.length > 0
                  ? `${displayReservations.length}件の予約があります`
                  : "予約はありません"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {displayReservations.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">
                  予約がありません
                </div>
              ) : (
                <div className="space-y-3">
                  {sortedReservations.map((r) => renderReservationItem(r, true))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Pending Tab */}
        <TabsContent value="pending" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>確定待ちの予約</CardTitle>
              <CardDescription>
                {pendingReservations.length > 0
                  ? `${pendingReservations.length}件の確認待ち予約があります`
                  : "確認待ちの予約はありません"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {pendingReservations.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">
                  確認待ちの予約はありません
                </div>
              ) : (
                <div className="space-y-3">
                  {pendingReservations.map((r) => renderReservationItem(r, true))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Cancelled Tab */}
        <TabsContent value="cancelled" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>キャンセルされた予約</CardTitle>
              <CardDescription>
                {cancelledReservations.length > 0
                  ? `${cancelledReservations.length}件`
                  : "キャンセルされた予約はありません"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {cancelledReservations.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">
                  キャンセルされた予約はありません
                </div>
              ) : (
                <div className="space-y-3">
                  {cancelledReservations.map((r) => renderReservationItem(r, true))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={null}>
      <DashboardContent />
    </Suspense>
  );
}
