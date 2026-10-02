"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Check, X, QrCode, ExternalLink, MessageCircle, Send, RefreshCw, GitMerge, User, Phone, Calendar } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { reservations, messages, mergeCandidates, type Reservation, type Message, type MergeCandidate, type ConsentRecord } from "@/lib/api";
import { useStore } from "@/contexts/store-context";
import { formatDate, formatPrice, cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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

const sourceColors: Record<string, string> = {
  hotpepper: "#CB006D",
  minimo: "#00A7FF",
  line: "#00B900",
  web: "#FD7878",
  phone: "#FD7878",
  "walk-in": "#FD7878",
};
const sourceLabels: Record<string, string> = {
  hotpepper: "HPB",
  minimo: "minimo",
  line: "LINE",
  web: "Web",
  phone: "電話",
  "walk-in": "来店",
};
const getSourceBadge = (source: Reservation["source"]) => (
  <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium text-white rounded" style={{ backgroundColor: sourceColors[source] || "#FD7878" }}>
    {sourceLabels[source] || source}
  </span>
);

const getSalonboardSyncBadge = (reservation: Reservation) => {
  if (reservation.source === "hotpepper") return null;
  if (reservation.salonboard_synced === undefined || reservation.salonboard_synced === 0) return null;

  if (reservation.salonboard_synced === 1) {
    return (
      <Badge variant="outline" className="border-blue-500 text-blue-600 text-xs bg-blue-50">
        SB連携済
      </Badge>
    );
  }
  if (reservation.salonboard_synced === -1) {
    return (
      <Badge
        variant="outline"
        className="border-red-500 text-red-600 text-xs bg-red-50"
        title={reservation.salonboard_sync_error || "エラー"}
      >
        SBエラー
      </Badge>
    );
  }
  return null;
};

const getConsentUrl = (storeId: string) => {
  return `https://example.com/consent?store_id=${storeId}`;
};

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
  const [syncing, setSyncing] = useState(false);

  // Merge candidates state
  const [mergeList, setMergeList] = useState<MergeCandidate[]>([]);
  const [mergingId, setMergingId] = useState<string | null>(null);

  // Consent modal state
  const [consentModalOpen, setConsentModalOpen] = useState(false);
  const [consentRecord, setConsentRecord] = useState<ConsentRecord | null>(null);
  const [consentLoading, setConsentLoading] = useState(false);

  // Chat modal state
  const [isChatModalOpen, setIsChatModalOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [sendToLine, setSendToLine] = useState(true);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
        // Fetch merge candidates if any exist
        if ((data.reservation.merge_candidate_count ?? 0) > 0 && currentStore) {
          try {
            const mc = await mergeCandidates.listByCustomer(data.reservation.customer_id, currentStore.id);
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
  }, [id, currentStore]);

  useEffect(() => {
    if (isChatModalOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages, isChatModalOpen]);

  const handleConfirm = async () => {
    if (!reservation) return;
    try {
      await reservations.confirm(reservation.id);
      setReservation({ ...reservation, status: "confirmed" });
    } catch (error) {
      console.error("Failed to confirm reservation:", error);
    }
  };

  const handleCancel = async () => {
    if (!reservation) return;
    if (!confirm("この予約をキャンセルしますか？")) return;
    try {
      await reservations.cancel(reservation.id);
      setReservation({ ...reservation, status: "cancelled" });
    } catch (error) {
      console.error("Failed to cancel reservation:", error);
    }
  };

  const openChatModal = async (customerId: string) => {
    setIsChatModalOpen(true);
    setLoadingMessages(true);
    setNewMessage("");
    setSendToLine(false);
    try {
      const data = await messages.get(customerId);
      setChatMessages(data.messages);
      await messages.markRead(customerId);
    } catch (error) {
      console.error("Failed to fetch messages:", error);
    } finally {
      setLoadingMessages(false);
    }
  };

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !reservation?.customer_id || sendingMessage) return;

    setSendingMessage(true);
    try {
      const { message } = await messages.send(
        reservation.customer_id,
        newMessage,
        sendToLine,
        currentStore?.id
      );
      setChatMessages((prev) => [...prev, message]);
      setNewMessage("");
      setSendToLine(false);
    } catch (error) {
      console.error("Failed to send message:", error);
      alert("メッセージの送信に失敗しました");
    } finally {
      setSendingMessage(false);
    }
  };

  const handleSyncSalonboard = async () => {
    if (!reservation) return;
    try {
      setSyncing(true);
      const result = await reservations.syncToSalonboard(reservation.id);
      if (result.success) {
        setReservation({
          ...reservation,
          salonboard_synced: 1,
          salonboard_synced_at: new Date().toISOString(),
          salonboard_sync_error: null,
        });
      } else {
        setReservation({
          ...reservation,
          salonboard_synced: -1,
          salonboard_synced_at: new Date().toISOString(),
          salonboard_sync_error: result.message,
        });
      }
    } catch {
      alert("サロンボード連携に失敗しました");
    } finally {
      setSyncing(false);
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

  return (
    <div className="max-w-lg mx-auto p-4 space-y-4">
      <Button variant="ghost" size="sm" onClick={() => router.back()}>
        <ChevronLeft className="h-4 w-4 mr-1" />
        戻る
      </Button>

      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">予約詳細</h2>
              {(() => {
                const sbId = reservation.salonboard_reserve_id || reservation.hotpepper_id;
                const synced = reservation.salonboard_synced;
                const hasError = !!reservation.salonboard_sync_error;
                if (synced === undefined || synced === 0) return null;
                if (reservation.status === "pending") return null;
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
            {reservation.has_consent ? (
              <Badge
                className="text-white text-xs cursor-pointer" style={{ backgroundColor: "#F36C21" }}
                onClick={async () => {
                  setConsentModalOpen(true);
                  setConsentLoading(true);
                  try {
                    const data = await reservations.getConsent(reservation.id);
                    setConsentRecord(data.consent);
                  } catch {
                    setConsentRecord(null);
                  }
                  setConsentLoading(false);
                }}
              >
                同意済み
              </Badge>
            ) : (
              <span className="inline-flex items-center px-2 py-0.5 text-xs text-muted-foreground border rounded-sm">未提出</span>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">日時</span>
              <span className="font-medium">
                {formatDate(reservation.start_at, "date")} {formatDate(reservation.start_at, "time")}〜{formatDate(reservation.end_at, "time")}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">お客様</span>
              <span className="font-medium">
                {reservation.customer_name}
                {(reservation.is_new_customer != null ? reservation.is_new_customer === 1 : reservation.customer_visit_count === 0) && (
                  <span className="ml-1 text-xs text-emerald-600 font-normal">新規</span>
                )}
              </span>
            </div>
            <div>
              <span className="text-sm text-muted-foreground">メニュー</span>
              {reservation.menus && reservation.menus.length > 0 ? (
                <div className="mt-1 space-y-1">
                  {reservation.menus.map((m, i) => (
                    <div key={i} className="flex justify-between text-sm">
                      <span className="font-medium">{m.name}</span>
                      <span className="text-muted-foreground">{m.duration}分 / {formatPrice(m.price)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex justify-between">
                  <span className="font-medium">{reservation.menu_name}</span>
                </div>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">担当</span>
              <span className="font-medium flex items-center gap-1.5">
                {reservation.staff_name}
                {reservation.is_nominated === 1 ? (
                  <span className="inline-flex items-center px-1 py-0.5 text-[9px] font-medium text-white rounded" style={{ backgroundColor: "#FD7878" }}>指名</span>
                ) : reservation.is_nominated === 0 ? (
                  <span className="inline-flex items-center px-1 py-0.5 text-[9px] font-medium text-white rounded" style={{ backgroundColor: "#3A76FD" }}>フリー</span>
                ) : null}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">料金</span>
              <span className="font-medium">{formatPrice(reservation.total_price || reservation.price || 0)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">ステータス</span>
              {getStatusBadge(reservation.status)}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">予約経路</span>
              {getSourceBadge(reservation.source)}
            </div>
            {/* Salonboard Sync Status */}
            {reservation.source !== "hotpepper" &&
             reservation.salonboard_synced !== undefined &&
             reservation.salonboard_synced !== 0 && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">SB連携</span>
                <div className="flex items-center gap-2">
                  {getSalonboardSyncBadge(reservation)}
                  {reservation.salonboard_synced_at && (
                    <span className="text-xs text-muted-foreground">
                      {formatDate(reservation.salonboard_synced_at, "datetime")}
                    </span>
                  )}
                </div>
              </div>
            )}
            {reservation.salonboard_synced === -1 &&
             reservation.salonboard_sync_error && (
              <div className="bg-red-50 border border-red-200 rounded-md p-2">
                <p className="text-xs text-red-700">{reservation.salonboard_sync_error}</p>
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
                    {/* LINE customer (current) */}
                    <div className="space-y-1">
                      <Badge variant="outline" className="text-[10px] border-green-400 text-green-600">
                        LINE（この予約）
                      </Badge>
                      <p className="text-sm font-medium truncate">{mc.line_customer_name}</p>
                      {mc.line_display_name && mc.line_display_name !== mc.line_customer_name && (
                        <p className="text-xs text-muted-foreground truncate">LINE: {mc.line_display_name}</p>
                      )}
                    </div>
                    {/* Existing customer */}
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
                            // Reload reservation to reflect merged customer
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

          {/* QR Code Section */}
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
                  value={getConsentUrl(reservation.store_id)}
                  size={180}
                  level="M"
                  marginSize={4}
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => window.open(getConsentUrl(reservation.store_id), '_blank')}
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                リンクを開く
              </Button>
            </div>
          </div>

          {/* Message Button */}
          <div className="border-t pt-4">
            <Button
              variant="outline"
              className="w-full"
              onClick={() => openChatModal(reservation.customer_id)}
            >
              <MessageCircle className="h-4 w-4 mr-2" />
              メッセージを送る
            </Button>
          </div>

          {/* Salonboard Sync Button */}
          {reservation.source !== "hotpepper" &&
           reservation.status === "confirmed" && (
            <div className="border-t pt-4">
              <Button
                variant="outline"
                className="w-full"
                onClick={handleSyncSalonboard}
                disabled={syncing}
              >
                <RefreshCw className={cn("h-4 w-4 mr-2", syncing && "animate-spin")} />
                {syncing
                  ? "サロンボード連携中..."
                  : reservation.salonboard_synced === 1
                    ? "サロンボードに再同期"
                    : reservation.salonboard_synced === -1
                      ? "サロンボード連携を再試行"
                      : "サロンボードに連携"}
              </Button>
            </div>
          )}

          {/* Action Buttons */}
          {reservation.status === "pending" && (
            <div className="border-t pt-4 flex gap-2">
              <Button
                className="flex-1"
                variant="outline"
                onClick={handleConfirm}
              >
                <Check className="h-4 w-4 mr-2" />
                予約を確定
              </Button>
              <Button
                variant="destructive"
                onClick={handleCancel}
              >
                <X className="h-4 w-4 mr-2" />
                キャンセル
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Chat Modal */}
      <Dialog open={isChatModalOpen} onOpenChange={setIsChatModalOpen}>
        <DialogContent className="max-w-md max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5" />
              {reservation.customer_name}さんとのメッセージ
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-auto min-h-[200px] max-h-[400px] p-2 border rounded-lg bg-muted/30">
            {loadingMessages ? (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                読み込み中...
              </div>
            ) : chatMessages.length === 0 ? (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                メッセージがありません
              </div>
            ) : (
              <div className="space-y-3">
                {chatMessages.map((message) => (
                  <div
                    key={message.id}
                    className={cn(
                      "flex",
                      message.direction === "outgoing" ? "justify-end" : "justify-start"
                    )}
                  >
                    <div
                      className={cn(
                        "max-w-[80%] rounded-lg px-3 py-2",
                        message.direction === "outgoing"
                          ? "bg-primary text-primary-foreground"
                          : "bg-white border"
                      )}
                    >
                      <p className="whitespace-pre-wrap text-sm">{message.content}</p>
                      <div
                        className={cn(
                          "mt-1 text-xs flex items-center gap-1",
                          message.direction === "outgoing"
                            ? "text-primary-foreground/70"
                            : "text-muted-foreground"
                        )}
                      >
                        {formatDate(message.sent_at, "time")}
                        {message.direction === "outgoing" && ((message as any).sent_by_staff_name || message.staff_name) && (
                          <span className="ml-1">{(message as any).sent_by_staff_name || message.staff_name}</span>
                        )}
                        {message.source === "line" && (
                          <Badge variant="outline" className="text-xs h-4 px-1 ml-1">
                            LINE
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          <div className="space-y-3 pt-2 flex-shrink-0">
            <div className="flex items-center gap-2">
              <Input
                placeholder="メッセージを入力..."
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
                className="flex-1"
              />
              <Button
                onClick={handleSendMessage}
                disabled={!newMessage.trim() || sendingMessage}
                size="icon"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="sendToLine"
                checked={sendToLine}
                onCheckedChange={(checked) => setSendToLine(checked === true)}
              />
              <label
                htmlFor="sendToLine"
                className="text-sm text-muted-foreground cursor-pointer"
              >
                公式LINEからも送信する
              </label>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
    </div>
  );
}
