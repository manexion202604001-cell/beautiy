"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Check, X, Pencil, QrCode, ExternalLink, MessageSquare, ClipboardList, GitMerge, User, Phone, Calendar, Copy, CalendarPlus } from "lucide-react";
import { CounselingSheetForm } from "@/components/counseling-sheet-form";
import CustomerDetail from "@/app/(dashboard)/customers/customer-detail";
import { QRCodeSVG } from "qrcode.react";
import { reservations, karutes, mergeCandidates, menus as menusApi, publicToken, walkinIntakes, type Reservation, type MergeCandidate, type Menu, type ConsentRecord } from "@/lib/api";
import { COUNSELING_CATEGORIES } from "@/lib/counseling-questions";
import { useStore } from "@/contexts/store-context";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate, formatPrice, formatDuration } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { CrossStoreNotice } from "@/components/cross-store-notice";
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

const getStatusBadge = (status: Reservation["status"]) => {
  switch (status) {
    case "pending":
      return <Badge variant="warning">確認待ち</Badge>;
    case "confirmed":
      return <Badge variant="success">確定</Badge>;
    case "completed":
      return <Badge variant="secondary">完了</Badge>;
    case "cancelled":
      return <Badge variant="destructive">キャンセル</Badge>;
    case "noshow":
      return <Badge variant="destructive">無断キャンセル</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
};

const getSourceBadge = (source: Reservation["source"]) => {
  switch (source) {
    case "web":
      return <Badge variant="outline" className="text-xs">Web</Badge>;
    case "line":
      return <Badge variant="outline" className="border-green-500 text-green-600 text-xs">LINE</Badge>;
    case "phone":
      return <Badge variant="outline" className="text-xs">電話</Badge>;
    case "walk-in":
      return <Badge variant="outline" className="text-xs">来店</Badge>;
    case "hotpepper":
      return <Badge variant="outline" className="border-orange-500 text-orange-600 text-xs bg-orange-50">HPB</Badge>;
    case "minimo":
      return <Badge variant="outline" className="border-blue-500 text-blue-600 text-xs bg-blue-50">minimo</Badge>;
    default:
      return <Badge variant="outline" className="text-xs">{source}</Badge>;
  }
};

function renderCounselingValue(v: unknown): string {
  if (Array.isArray(v)) return v.join("、");
  return String(v ?? "");
}

// Get reservation ID from URL for Cloudflare Pages static rewrite
function getReservationIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const idx = pathParts.indexOf('reservations');
  if (idx !== -1 && pathParts[idx + 1] && pathParts[idx + 1] !== 'placeholder') {
    return pathParts[idx + 1];
  }
  return null;
}

export default function ReservationDetail({ id: propsId }: { id: string }) {
  const router = useRouter();
  const { currentStore } = useStore();

  const [id, setId] = useState<string>(() => {
    const urlId = getReservationIdFromUrl();
    return urlId || propsId;
  });

  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [karuteLoading, setKaruteLoading] = useState(false);
  const [counselingOpen, setCounselingOpen] = useState(false);
  const [customerDetailOpen, setCustomerDetailOpen] = useState(false);
  const [counselingHistoryOpen, setCounselingHistoryOpen] = useState(false);
  const [counselingHistoryLoading, setCounselingHistoryLoading] = useState(false);
  const [counselingHistory, setCounselingHistory] = useState<Array<{
    id: string;
    customer_name: string;
    counseling_data: Record<string, Record<string, unknown>> | null;
    updated_at: string;
  }>>([]);

  const openCounselingHistory = async () => {
    if (!reservation?.customer_id) return;
    setCounselingHistoryOpen(true);
    setCounselingHistoryLoading(true);
    try {
      const res = await walkinIntakes.byCustomer(reservation.customer_id);
      setCounselingHistory(res.intakes);
    } catch (e) {
      console.error(e);
    } finally {
      setCounselingHistoryLoading(false);
    }
  };

  // Lock body scroll when bottom sheet is open
  useEffect(() => {
    if (counselingOpen || customerDetailOpen) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [counselingOpen, customerDetailOpen]);

  // Consent modal state
  const [consentModalOpen, setConsentModalOpen] = useState(false);
  const [consentRecord, setConsentRecord] = useState<ConsentRecord | null>(null);
  const [consentLoading, setConsentLoading] = useState(false);

  // Merge candidates state
  const [mergeList, setMergeList] = useState<MergeCandidate[]>([]);
  const [mergingId, setMergingId] = useState<string | null>(null);

  // Public token for consent/counseling links
  const [consentToken, setConsentToken] = useState<string | null>(null);

  // Next reservation
  const [nextOpen, setNextOpen] = useState(false);
  const [nextDate, setNextDate] = useState("");
  const [nextTime, setNextTime] = useState("");
  const [nextMemo, setNextMemo] = useState("");
  const [nextCreating, setNextCreating] = useState(false);
  const [nextMenuIds, setNextMenuIds] = useState<string[]>([]);
  const [storeMenus, setStoreMenus] = useState<Menu[]>([]);

  // Resolve ID on client side (Cloudflare Pages rewrite serves placeholder page)
  useEffect(() => {
    const urlId = getReservationIdFromUrl();
    if (urlId) {
      setId(urlId);
    }
  }, []);

  useEffect(() => {
    if (id === 'placeholder') return;
    const fetchReservation = async () => {
      try {
        const data = await reservations.get(id);
        setReservation(data.reservation);
        // Generate public token for consent/counseling links
        try {
          const { token } = await publicToken.generate(data.reservation.store_id);
          setConsentToken(token);
        } catch (e) {
          console.error("Failed to generate public token:", e);
        }
        // Fetch merge candidates if any exist
        if ((data.reservation.merge_candidate_count ?? 0) > 0) {
          try {
            const mc = await mergeCandidates.listByCustomer(data.reservation.customer_id, data.reservation.store_id);
            setMergeList(mc.candidates);
          } catch (e) {
            console.error("Failed to fetch merge candidates:", e);
          }
        }
      } catch (error) {
        console.error("Failed to fetch reservation:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchReservation();
  }, [id]);

  // Poll while SB registration is in progress (synced=0) so the badge
  // updates to ✓ without a manual reload once the VPS finishes (~1-2 min).
  useEffect(() => {
    if (!reservation) return;
    if (reservation.status === "pending") return;
    if (reservation.salonboard_synced !== 0) return;
    let cancelled = false;
    let tries = 0;
    const interval = setInterval(async () => {
      tries++;
      try {
        const data = await reservations.get(reservation.id);
        if (cancelled) return;
        if (data.reservation.salonboard_synced !== 0) {
          setReservation(data.reservation);
          clearInterval(interval);
        }
      } catch { /* transient; keep polling */ }
      if (tries >= 20) clearInterval(interval); // ~5 min max
    }, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [reservation?.id, reservation?.salonboard_synced, reservation?.status]);

  const handleConfirm = async () => {
    if (!reservation) return;
    setActionLoading(true);
    try {
      await reservations.confirm(reservation.id);
      setReservation({ ...reservation, status: "confirmed" });
    } catch (error) {
      console.error("Failed to confirm:", error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleComplete = async () => {
    if (!reservation) return;
    if (!confirm("施術完了にしますか？")) return;
    setActionLoading(true);
    try {
      await reservations.complete(reservation.id);
      setReservation({ ...reservation, status: "completed" });
    } catch (error) {
      console.error("Failed to complete:", error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRevertToConfirmed = async () => {
    if (!reservation) return;
    if (!confirm("ステータスを「確定」に戻しますか？")) return;
    setActionLoading(true);
    try {
      await reservations.update(reservation.id, { status: "confirmed" });
      setReservation({ ...reservation, status: "confirmed" });
    } catch (error) {
      console.error("Failed to revert:", error);
      alert("ステータスの変更に失敗しました");
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!reservation) return;
    setActionLoading(true);
    try {
      await reservations.cancel(reservation.id);
      setReservation({ ...reservation, status: "cancelled" });
    } catch (error) {
      console.error("Failed to cancel:", error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleKarute = async () => {
    if (!reservation || !reservation.customer_id) return;
    setKaruteLoading(true);
    try {
      // Check if karute already exists for this reservation
      const { karutes: existing } = await karutes.list({ reservation_id: reservation.id });
      if (existing.length > 0) {
        router.push(`/customers/karutes/${existing[0].id}`);
        return;
      }
      // Create new karute with pre-filled data
      const visitDate = reservation.start_at.split("T")[0];
      const menuIds = reservation.menus?.map((m) => m.id) || [];
      const { karute } = await karutes.create({
        store_id: reservation.store_id,
        customer_id: reservation.customer_id,
        reservation_id: reservation.id,
        visit_date: visitDate,
        menu_ids: menuIds,
      });
      router.push(`/customers/karutes/${karute.id}`);
    } catch (error) {
      console.error("Failed to open karute:", error);
    } finally {
      setKaruteLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <p className="text-muted-foreground">読み込み中...</p>
      </div>
    );
  }

  if (!reservation) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
        <p className="text-muted-foreground">予約が見つかりません</p>
        <Button variant="outline" onClick={() => router.back()}>
          <ChevronLeft className="h-4 w-4 mr-1" />
          戻る
        </Button>
      </div>
    );
  }

  const isNew = reservation.is_new_customer != null
    ? reservation.is_new_customer === 1
    : reservation.customer_visit_count === 0;
  const isRepeater = reservation.is_new_customer != null
    ? reservation.is_new_customer === 0
    : (reservation.customer_visit_count != null && reservation.customer_visit_count > 0);

  return (
    <div className="-mx-4 md:-mx-6">
      <div className="max-w-lg mx-auto p-4 space-y-4">
      <Button variant="ghost" size="sm" onClick={() => router.back()}>
        <ChevronLeft className="h-4 w-4 mr-1" />
        戻る
      </Button>

      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">予約詳細</h2>
            {(() => {
              const sbId = reservation.salonboard_reserve_id || reservation.hotpepper_id;
              const synced = reservation.salonboard_synced;
              const hasError = !!reservation.salonboard_sync_error;
              if (synced === undefined) return null;
              if (reservation.status === "pending") return null;
              if (synced === 0) {
                return (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-sm text-muted-foreground" title="SBへの連携処理を実行中です（通常1〜2分）">
                    <span className="inline-block h-3 w-3 rounded-full border-2 border-muted-foreground/40 border-t-muted-foreground animate-spin" />
                    SB連携中…
                  </span>
                );
              }
              const sbUrl = sbId
                ? sbId.startsWith("BE")
                  ? `https://salonboard.com/KLP/reserve/net/reserveDetail/?reserveId=${sbId}`
                  : `https://salonboard.com/KLP/reserve/ext/extReserveDetail/?reserveId=${sbId}`
                : null;
              const title = hasError
                ? `SB変更エラー: ${reservation.salonboard_sync_error}`
                : synced === 1
                  ? (sbId ? `SB連携済 ${sbId}` : "SB連携済（IDなし）")
                  : synced === -1
                    ? `SBエラー: ${reservation.salonboard_sync_error || "不明"}`
                    : synced === -2 ? "HPB ID未設定" : "";
              const icon = synced === 1 && hasError ? (
                <span className="text-orange-500">⚠</span>
              ) : synced === 1 ? (
                <>{sbId ? <span className="text-green-600">✓</span> : <><span className="text-green-600">✓</span><span className="text-yellow-600 text-sm">⚠</span></>}</>
              ) : synced === -1 ? (
                <span className="text-red-500">✗</span>
              ) : synced === -2 ? (
                <span className="text-yellow-600">!</span>
              ) : null;
              const borderClass = hasError ? "border-orange-300" : "";
              return sbUrl && synced === 1 && sbId ? (
                <a href={sbUrl} target="_blank" rel="noopener noreferrer" className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-sm hover:bg-muted transition-colors ${borderClass}`} title={title}>
                  {icon}SB予約詳細<ExternalLink className="h-3 w-3 text-muted-foreground" />
                </a>
              ) : (
                <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full border text-sm ${borderClass}`} title={title}>
                  {icon}<span className="text-muted-foreground">SB</span>
                </span>
              );
            })()}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground shrink-0">日時</span>
              <span className="font-medium">
                {formatDate(reservation.start_at, "date")}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground shrink-0">時間</span>
              <span className="font-medium">
                {formatDate(reservation.start_at, "time")}〜{formatDate(reservation.end_at, "time")}
                {(reservation.total_duration || reservation.duration) && (
                  <span className="ml-1 text-muted-foreground text-sm">({formatDuration((reservation.total_duration || reservation.duration) as number)})</span>
                )}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground shrink-0">お客様</span>
              <div className="text-right">
                <span className="font-medium">
                  {reservation.customer_name || "未設定"}
                  {reservation.is_minimo === 1 && (
                    <span className="ml-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium text-white" style={{ backgroundColor: "#00A7FF" }}>minimo</span>
                  )}
                </span>
                {reservation.customer_phone && (
                  <div className="text-xs text-muted-foreground">{reservation.customer_phone}</div>
                )}
                {reservation.customer_id && (
                  <div className="mt-1 flex justify-end">
                    {reservation.has_line === 1 ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-green-500/40 bg-green-50 px-2 py-0.5 text-[10px] font-medium text-green-700">
                        ✓ LINE連携（この店舗）
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/50 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                        ⚠ LINE未連携（この店舗）
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
            {reservation.customer_id && (
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setCustomerDetailOpen(true)}
                  className="text-xs text-primary font-medium px-3 py-1 rounded-full bg-white border border-primary/20 shadow-sm hover:shadow transition-shadow"
                >
                  顧客情報
                </button>
                <button
                  onClick={() => setCounselingOpen(true)}
                  className="text-xs text-primary font-medium px-3 py-1 rounded-full bg-white border border-primary/20 shadow-sm hover:shadow transition-shadow"
                >
                  カウンセリングシート
                </button>
              </div>
            )}
            <CrossStoreNotice
              phone={reservation.customer_phone}
              excludeStoreId={reservation.store_id}
            />
            <div>
              <span className="text-sm text-muted-foreground">メニュー</span>
              {reservation.menus && reservation.menus.length > 0 ? (
                <div className="bg-muted/50 rounded-md p-3 space-y-1 mt-1">
                  {reservation.menus.map((m: { id: string; name: string; duration: number; price: number }, idx: number) => (
                    <div key={idx} className="flex items-center justify-between text-sm gap-2">
                      <span className="min-w-0">{m.name}</span>
                      <span className="text-muted-foreground text-xs shrink-0">{formatDuration(m.duration)} / {formatPrice(m.price)}</span>
                    </div>
                  ))}
                  {reservation.menus.length > 1 && (
                    <div className="flex items-center justify-between text-sm font-medium border-t pt-1 mt-1">
                      <span>合計</span>
                      <span>{formatDuration(reservation.total_duration || 0)} / {formatPrice(reservation.total_price || 0)}</span>
                    </div>
                  )}
                </div>
              ) : (
                <p className="font-medium mt-1">{reservation.menu_name || "未設定"}</p>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground shrink-0">担当</span>
              <span className="font-medium">{reservation.staff_nickname || reservation.staff_name || "未設定"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground shrink-0">料金</span>
              <span className="font-medium">{formatPrice(reservation.total_price || reservation.price || 0)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground shrink-0">ステータス</span>
              {getStatusBadge(reservation.status)}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground shrink-0">予約経路</span>
              {getSourceBadge(reservation.source)}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground shrink-0">指名</span>
              {reservation.is_nominated === 1 ? (
                <Badge className="bg-[#FD7878] text-white text-xs">指名</Badge>
              ) : reservation.is_nominated === 0 ? (
                <Badge className="bg-[#3A76FD] text-white text-xs">フリー</Badge>
              ) : (
                <span className="text-sm text-muted-foreground">-</span>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground shrink-0">顧客タイプ</span>
              {isNew ? (
                <Badge className="bg-[#3A76FD] text-white text-xs">新規</Badge>
              ) : isRepeater ? (
                <Badge className="bg-[#FD7878] text-white text-xs">リピーター</Badge>
              ) : (
                <span className="text-sm text-muted-foreground">-</span>
              )}
            </div>
            {reservation.memo && (
              <div>
                <span className="text-sm text-muted-foreground">メモ</span>
                <p className="whitespace-pre-wrap text-sm mt-1">{reservation.memo}</p>
              </div>
            )}
            {reservation.lime_menu_name && (
              <div>
                <span className="text-sm text-muted-foreground">LiMEメニュー</span>
                <p className="font-medium text-sm mt-1">{reservation.lime_menu_name}</p>
              </div>
            )}
          </div>

          {/* Merge Candidates Section */}
          {mergeList.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-md p-3 space-y-3">
              <p className="text-sm font-medium text-amber-800 flex items-center gap-1.5">
                <GitMerge className="h-4 w-4" />
                既存顧客との統合候補があります
              </p>
              {mergeList.map((mc) => (
                <div key={mc.id} className="bg-white rounded-md border p-3 space-y-2">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Badge variant="outline" className="text-[10px] border-green-400 text-green-600">
                        LINE（この予約）
                      </Badge>
                      <p className="text-sm font-medium truncate">{mc.line_customer_name}</p>
                      {mc.line_display_name && mc.line_display_name !== mc.line_customer_name && (
                        <p className="text-xs text-muted-foreground truncate">LINE: {mc.line_display_name}</p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <Badge variant="outline" className="text-[10px] border-blue-400 text-blue-600">
                        既存
                      </Badge>
                      <p className="text-sm font-medium truncate">{mc.existing_customer_name}</p>
                      <div className="text-xs text-muted-foreground space-y-0.5">
                        {mc.existing_customer_phone && (
                          <div className="flex items-center gap-1">
                            <Phone className="h-3 w-3" />
                            {mc.existing_customer_phone}
                          </div>
                        )}
                        <div className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          来店{mc.existing_customer_visit_count}回
                        </div>
                        {mc.existing_customer_staff_name && (
                          <div className="flex items-center gap-1">
                            <User className="h-3 w-3" />
                            {mc.existing_customer_staff_name}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between pt-1 border-t">
                    <Badge variant="secondary" className="text-[10px]">
                      {mc.match_type === "phone" ? "電話番号一致" : mc.match_type === "name_kana" ? "読み仮名一致" : "名前一致"}
                    </Badge>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={mergingId === mc.id}
                        onClick={async () => {
                          setMergingId(mc.id);
                          try {
                            await mergeCandidates.skip(mc.id);
                            setMergeList((prev) => prev.filter((c) => c.id !== mc.id));
                          } catch { alert("スキップに失敗しました"); }
                          finally { setMergingId(null); }
                        }}
                      >
                        <X className="mr-1 h-3 w-3" />
                        スキップ
                      </Button>
                      <Button
                        size="sm"
                        disabled={mergingId === mc.id}
                        onClick={async () => {
                          if (!confirm(`「${mc.line_customer_name}」を「${mc.existing_customer_name}」に統合しますか？\nこの操作は取り消せません。`)) return;
                          setMergingId(mc.id);
                          try {
                            await mergeCandidates.merge(mc.id);
                            setMergeList((prev) => prev.filter((c) => c.id !== mc.id));
                            const data = await reservations.get(id);
                            setReservation(data.reservation);
                          } catch { alert("統合に失敗しました"); }
                          finally { setMergingId(null); }
                        }}
                      >
                        <GitMerge className="mr-1 h-3 w-3" />
                        統合する
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Edit Button */}
          {(reservation.status === "pending" || reservation.status === "confirmed") && (
            <div className="border-t pt-4">
              <Button
                variant="outline"
                className="w-full"
                onClick={() => router.push(`/reservations/${reservation.id}/edit`)}
              >
                <Pencil className="h-4 w-4 mr-2" />
                予約を編集
              </Button>
            </div>
          )}

          {/* Action Buttons */}
          {(reservation.status === "pending" || reservation.status === "confirmed") && (
            <div className="border-t pt-4 flex gap-2">
              {reservation.status === "pending" && (
                <Button className="flex-1" variant="outline" onClick={handleConfirm} disabled={actionLoading}>
                  <Check className="h-4 w-4 mr-2" />
                  予約を確定
                </Button>
              )}
              {reservation.status === "confirmed" && (
                <Button className="flex-1" onClick={handleComplete} disabled={actionLoading}>施術完了</Button>
              )}
              <Button variant="destructive" onClick={() => setCancelDialogOpen(true)} disabled={actionLoading}>
                <X className="h-4 w-4 mr-2" />
                キャンセル
              </Button>
            </div>
          )}
          {reservation.status === "completed" && (
            <div className="border-t pt-4">
              <Button variant="outline" className="w-full" onClick={handleRevertToConfirmed} disabled={actionLoading}>
                ステータスを「確定」に戻す
              </Button>
            </div>
          )}

          {/* Message Button */}
          {reservation.customer_id && (
            <div className="border-t pt-4">
              <Button
                variant="outline"
                className="w-full bg-green-600 text-white hover:bg-green-700"
                onClick={() => router.push(`/messages?customer_id=${reservation.customer_id}${reservation.staff_id ? `&staff_id=${reservation.staff_id}` : ''}`)}
              >
                <MessageSquare className="h-4 w-4 mr-2" />
                メッセージを送る
              </Button>
            </div>
          )}


          {/* Next Reservation Button */}
          {reservation.status !== 'cancelled' && reservation.status !== 'noshow' && (
            <div className="border-t pt-4">
              <Button
                variant="outline"
                className="w-full"
                onClick={async () => {
                  const menuData = reservation.menus?.length
                    ? reservation.menus
                        .filter(m => m.name !== '（メニュー未設定）' && m.name !== '不明なメニュー')
                        .map(m => ({ id: m.id, name: m.name, duration: m.duration, price: m.price }))
                    : [];
                  const params = new URLSearchParams();
                  params.set("customer_id", reservation.customer_id);
                  params.set("customer_name", reservation.customer_name || "");
                  if (reservation.staff_id) params.set("staff_id", reservation.staff_id);
                  if (menuData.length > 0) params.set("menu_data", JSON.stringify(menuData));
                  params.set("source", "next-visit");
                  router.push(`/reservations/new?${params.toString()}`);
                }}
              >
                <CalendarPlus className="h-4 w-4 mr-2" />
                次回予約を取る
              </Button>
            </div>
          )}

          {/* Counseling Sheet (inline) */}
          {reservation.customer_id && (
            <div className="border-t pt-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <ClipboardList className="h-4 w-4" />
                  カウンセリングシート
                </div>
                <button
                  className="text-xs text-primary font-medium px-3 py-1 rounded-full bg-white border border-primary/20 shadow-sm hover:shadow transition-shadow"
                  onClick={openCounselingHistory}
                >
                  登録履歴
                </button>
              </div>
              <CounselingSheetForm
                customerId={reservation.customer_id}
                storeId={reservation.store_id}
                embedded
              />
            </div>
          )}

          {/* Consent & Counseling QR Code */}
          <div className="border-t pt-4">
            <div className="text-center space-y-3">
              <div className="flex items-center justify-center gap-2 text-sm font-medium">
                <QrCode className="h-4 w-4" />
                同意書・カウンセリングシート
              </div>
              <p className="text-xs text-muted-foreground">
                QRコードをスキャンすると、同意書の記入後<br />
                続けてカウンセリングシートに進めます。
              </p>
              <div className="flex justify-center p-4 bg-white rounded-lg">
                <QRCodeSVG
                  value={`https://example.com/consent?store_id=${reservation.store_id}&reservation_id=${reservation.id}${consentToken ? `&token=${consentToken}` : ''}`}
                  size={180}
                  level="M"
                  marginSize={4}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    navigator.clipboard.writeText(`https://example.com/consent?store_id=${reservation.store_id}&reservation_id=${reservation.id}${consentToken ? `&token=${consentToken}` : ''}`);
                  }}
                >
                  <Copy className="h-4 w-4 mr-2" />
                  URLコピー
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => window.open(`https://example.com/consent?store_id=${reservation.store_id}&reservation_id=${reservation.id}${consentToken ? `&token=${consentToken}` : ''}`, '_blank')}
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  リンクを開く
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
      </div>

      {/* Floating Karute Button */}
      {reservation.customer_id && (
        <button
          onClick={handleKarute}
          disabled={karuteLoading}
          className="fixed bottom-20 right-4 md:bottom-6 md:right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          <ClipboardList className="h-6 w-6" />
        </button>
      )}

      {/* Counseling Sheet Bottom Sheet */}
      {counselingOpen && reservation.customer_id && (
        <>
          <div className="fixed inset-0 z-50 bg-black/40" onClick={() => setCounselingOpen(false)} />
          <div
            className="fixed inset-x-0 bottom-0 z-50 bg-background rounded-t-2xl shadow-[0_-4px_24px_rgba(0,0,0,0.15)] animate-in slide-in-from-bottom duration-300 overflow-hidden"
            style={{ top: "3rem" }}
            onTouchMove={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
              <h2 className="text-base font-semibold">カウンセリングシート</h2>
              <button
                onClick={() => setCounselingOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="overflow-y-auto overflow-x-hidden p-4 pb-24" style={{ height: "calc(100vh - 3rem - 49px)" }}>
              <div className="max-w-full overflow-hidden">
                <CounselingSheetForm
                  customerId={reservation.customer_id}
                  storeId={reservation.store_id}
                />
              </div>
            </div>
          </div>
        </>
      )}

      {/* Customer Detail Bottom Sheet */}
      {customerDetailOpen && reservation.customer_id && (
        <>
          <div className="fixed inset-0 z-50 bg-black/40" onClick={() => setCustomerDetailOpen(false)} />
          <div
            className="fixed inset-x-0 bottom-0 z-50 bg-background rounded-t-2xl shadow-[0_-4px_24px_rgba(0,0,0,0.15)] animate-in slide-in-from-bottom duration-300 overflow-hidden"
            style={{ top: "3rem" }}
            onTouchMove={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
              <h2 className="text-base font-semibold">顧客情報</h2>
              <button
                onClick={() => setCustomerDetailOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="overflow-y-auto overflow-x-hidden p-4 pb-24" style={{ height: "calc(100vh - 3rem - 49px)" }}>
              <div className="max-w-full overflow-hidden">
                <CustomerDetail
                  id={reservation.customer_id}
                  onClose={() => setCustomerDetailOpen(false)}
                />
              </div>
            </div>
          </div>
        </>
      )}

      {/* Next Reservation Dialog */}
      <Dialog open={nextOpen} onOpenChange={setNextOpen}>
        <DialogContent className="max-w-sm max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>次回予約を取る</DialogTitle>
          </DialogHeader>
          {reservation && (() => {
            const selectedMenus = storeMenus.filter(m => nextMenuIds.includes(m.id));
            const totalDur = selectedMenus.length > 0
              ? selectedMenus.reduce((sum, m) => sum + m.duration, 0)
              : (reservation.total_duration || reservation.duration || 0);
            return (
            <div className="space-y-4 text-sm overflow-y-auto flex-1 -mr-2 pr-2">
              <div className="space-y-1 rounded-md border p-3 bg-muted/30">
                <div className="grid grid-cols-[60px_1fr] gap-y-1">
                  <span className="text-muted-foreground">顧客</span>
                  <span className="font-medium">{reservation.customer_name}</span>
                  <span className="text-muted-foreground">スタッフ</span>
                  <span>{reservation.staff_nickname || reservation.staff_name}</span>
                </div>
              </div>

              {/* Menu Selection */}
              <div className="space-y-2">
                <Label>メニュー</Label>
                {storeMenus.length > 0 ? (
                  <div className="max-h-40 overflow-y-auto rounded-md border divide-y">
                    {storeMenus.map((m) => (
                      <label key={m.id} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/30">
                        <input
                          type="checkbox"
                          checked={nextMenuIds.includes(m.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setNextMenuIds(prev => [...prev, m.id]);
                            } else {
                              setNextMenuIds(prev => prev.filter(id => id !== m.id));
                            }
                          }}
                          className="h-4 w-4 rounded accent-[hsl(31.5,35.5%,56.9%)]"
                        />
                        <span className="flex-1 min-w-0 truncate">{m.name}</span>
                        <span className="text-xs text-muted-foreground shrink-0">{m.duration}分</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground">{reservation.menus?.map(m => m.name).join(", ") || reservation.menu_name || "-"}</p>
                )}
                <p className="text-xs text-muted-foreground">所要時間: {totalDur}分</p>
              </div>

              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="next-date">日付</Label>
                  <Input
                    id="next-date"
                    type="date"
                    value={nextDate}
                    onChange={(e) => setNextDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="next-time">開始時刻</Label>
                  <Input
                    id="next-time"
                    type="time"
                    step="300"
                    value={nextTime}
                    onChange={(e) => setNextTime(e.target.value)}
                  />
                </div>
                {nextDate && nextTime && (
                  <p className="text-xs text-muted-foreground">
                    終了: {(() => {
                      const [h, m] = nextTime.split(":").map(Number);
                      const endMin = h * 60 + m + totalDur;
                      return `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
                    })()}
                  </p>
                )}
                <div className="space-y-1">
                  <Label htmlFor="next-memo">メモ（任意）</Label>
                  <Input
                    id="next-memo"
                    value={nextMemo}
                    onChange={(e) => setNextMemo(e.target.value)}
                    placeholder="メモ"
                  />
                </div>
              </div>

              <Button
                className="w-full"
                disabled={!nextDate || !nextTime || nextMenuIds.length === 0 || nextCreating}
                onClick={async () => {
                  if (!nextDate || !nextTime) return;
                  setNextCreating(true);
                  try {
                    const [h, m] = nextTime.split(":").map(Number);
                    const startJst = new Date(`${nextDate}T${nextTime}:00+09:00`);
                    const endMin = h * 60 + m + totalDur;
                    const endJst = new Date(`${nextDate}T${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}:00+09:00`);

                    await reservations.create({
                      store_id: reservation.store_id,
                      customer_id: reservation.customer_id,
                      staff_id: reservation.staff_id,
                      menu_ids: nextMenuIds,
                      start_at: startJst.toISOString(),
                      end_at: endJst.toISOString(),
                      memo: nextMemo || null,
                      source: "phone",
                      is_nominated: reservation.is_nominated ?? 1,
                    });
                    setNextOpen(false);
                    router.push("/reservations");
                  } catch (err) {
                    alert(err instanceof Error ? err.message : "予約作成に失敗しました");
                  } finally {
                    setNextCreating(false);
                  }
                }}
              >
                {nextCreating ? "作成中..." : "予約を作成"}
              </Button>
            </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      <AlertDialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>予約をキャンセルしますか？</AlertDialogTitle>
            <AlertDialogDescription>
              この操作は取り消せません。予約をキャンセルしてもよろしいですか？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>戻る</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleCancel}
            >
              キャンセルする
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Consent Record Modal */}
      <Dialog open={consentModalOpen} onOpenChange={setConsentModalOpen}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>同意書</DialogTitle>
          </DialogHeader>
          {consentLoading ? (
            <div className="flex justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-[#b8936a] border-t-transparent" />
            </div>
          ) : consentRecord ? (
            <div className="space-y-4 text-sm">
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">お名前</span>
                  <span className="font-medium">{consentRecord.customer_name}</span>
                </div>
                {consentRecord.customer_birthday && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">生年月日</span>
                    <span>{consentRecord.customer_birthday}</span>
                  </div>
                )}
                {consentRecord.customer_phone && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">電話番号</span>
                    <span>{consentRecord.customer_phone}</span>
                  </div>
                )}
                {consentRecord.customer_occupation && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">職業</span>
                    <span>{consentRecord.customer_occupation}</span>
                  </div>
                )}
                {consentRecord.customer_visit_reason && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">来店理由</span>
                    <span>{consentRecord.customer_visit_reason}</span>
                  </div>
                )}
              </div>
              {consentRecord.template_snapshot?.sections && (
                <div className="space-y-3 border-t pt-3">
                  {consentRecord.template_snapshot.sections.map((section, i) => (
                    <div key={i}>
                      <h4 className="font-medium text-sm">{section.title}</h4>
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap mt-1">{section.content}</p>
                    </div>
                  ))}
                </div>
              )}
              <div className="border-t pt-3 text-xs text-muted-foreground">
                同意日時: {consentRecord.agreed_at ? formatDate(consentRecord.agreed_at, "datetime") : "-"}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-4">同意書データが見つかりません</p>
          )}
        </DialogContent>
      </Dialog>

      {/* Counseling Sheet History Dialog */}
      <Dialog open={counselingHistoryOpen} onOpenChange={setCounselingHistoryOpen}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle>カウンセリングシート登録履歴</DialogTitle>
          </DialogHeader>
          {counselingHistoryLoading ? (
            <p className="text-sm text-muted-foreground py-4 text-center">読み込み中...</p>
          ) : counselingHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">登録履歴がありません</p>
          ) : (
            <div className="space-y-3">
              {counselingHistory.map((record) => (
                <div key={record.id} className="rounded-md border p-3 space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{record.customer_name}</span>
                    <span className="text-xs text-muted-foreground">{formatDate(record.updated_at, "datetime")}</span>
                  </div>
                  {record.counseling_data && COUNSELING_CATEGORIES.filter((cat) => record.counseling_data?.[cat.id]).map((cat) => (
                    <div key={cat.id} className="rounded border p-2">
                      <p className="font-medium text-xs mb-1">{cat.label}</p>
                      <div className="space-y-0.5">
                        {cat.questions.map((q) => {
                          const val = record.counseling_data?.[cat.id]?.[q.id];
                          if (val == null || val === "" || (Array.isArray(val) && val.length === 0)) return null;
                          return (
                            <div key={q.id} className="text-xs flex gap-1">
                              <span className="text-muted-foreground shrink-0">{q.label}:</span>
                              <span>{renderCounselingValue(val)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
