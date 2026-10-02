"use client";

import { useEffect, useRef, useState } from "react";


import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Calendar, Users, MessageSquare, Clock, Check, X, ChevronRight, MessageCircle, Send } from "lucide-react";
import { reservations, messages, type Reservation, type Message } from "@/lib/api";
import { formatDate, formatPrice, cn } from "@/lib/utils";
import { useStore } from "@/contexts/store-context";

export default function DashboardPage() {
  const { currentStore } = useStore();
  const [todayReservations, setTodayReservations] = useState<Reservation[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedReservation, setSelectedReservation] = useState<Reservation | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);

  // Chat modal state
  const [isChatModalOpen, setIsChatModalOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [sendToLine, setSendToLine] = useState(true);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchData = async () => {
      if (!currentStore) return;
      setLoading(true);
      try {
        const today = new Date().toISOString().split("T")[0];
        const [resData, msgData] = await Promise.all([
          reservations.list({ date: today }),
          messages.unreadCount(),
        ]);
        setTodayReservations(resData.reservations);
        setUnreadCount(msgData.count);
      } catch (error) {
        console.error("Failed to fetch dashboard data:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [currentStore?.id]);

  useEffect(() => {
    if (isChatModalOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages, isChatModalOpen]);

  const pendingCount = todayReservations.filter((r) => r.status === "pending").length;
  const confirmedCount = todayReservations.filter((r) => r.status === "confirmed").length;

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
    }
  };

  const handleConfirm = async (id: string) => {
    try {
      await reservations.confirm(id);
      setTodayReservations((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: "confirmed" as const } : r))
      );
      if (selectedReservation?.id === id) {
        setSelectedReservation({ ...selectedReservation, status: "confirmed" });
      }
    } catch (error) {
      console.error("Failed to confirm:", error);
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await reservations.cancel(id);
      setTodayReservations((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: "cancelled" as const } : r))
      );
      setIsDetailOpen(false);
    } catch (error) {
      console.error("Failed to cancel:", error);
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
    if (!newMessage.trim() || !selectedReservation?.customer_id || sendingMessage) return;

    setSendingMessage(true);
    try {
      const { message } = await messages.send(
        selectedReservation.customer_id,
        newMessage,
        sendToLine,
        currentStore?.id
      );
      setChatMessages((prev) => [...prev, message]);
      setNewMessage("");
      setSendToLine(false);
    } catch (error) {
      alert("メッセージの送信に失敗しました");
    } finally {
      setSendingMessage(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">ダッシュボード</h1>
        <p className="text-muted-foreground">{formatDate(new Date(), "date")}</p>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">本日の予約</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{todayReservations.length}</div>
            <p className="text-xs text-muted-foreground">
              確認待ち: {pendingCount}件
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">確定済み</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{confirmedCount}</div>
            <p className="text-xs text-muted-foreground">本日の確定予約</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">未読メッセージ</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{unreadCount}</div>
            <p className="text-xs text-muted-foreground">対応が必要</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">本日の売上見込み</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatPrice(
                todayReservations
                  .filter((r) => ["confirmed", "completed"].includes(r.status))
                  .reduce((sum, r) => sum + (r.price || 0), 0)
              )}
            </div>
            <p className="text-xs text-muted-foreground">確定+完了分</p>
          </CardContent>
        </Card>
      </div>

      {/* Today's Schedule */}
      <Card>
        <CardHeader>
          <CardTitle>本日の予約一覧</CardTitle>
          <CardDescription>
            {todayReservations.length > 0
              ? `${todayReservations.length}件の予約があります`
              : "本日の予約はありません"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {todayReservations.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              予約がありません
            </div>
          ) : (
            <div className="space-y-4">
              {todayReservations.map((reservation) => (
                <div
                  key={reservation.id}
                  className="flex items-center justify-between rounded-lg border p-4 cursor-pointer transition-colors hover:bg-muted/50"
                  onClick={() => {
                    setSelectedReservation(reservation);
                    setIsDetailOpen(true);
                  }}
                >
                  <div className="flex items-center gap-4">
                    <div className="text-center">
                      <div className="text-lg font-bold">
                        {formatDate(reservation.start_at, "time")}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        〜{formatDate(reservation.end_at, "time")}
                      </div>
                    </div>
                    <div>
                      <div className="font-medium">{reservation.customer_name}</div>
                      <div className="text-sm text-muted-foreground">
                        {reservation.menu_name} / 担当: {reservation.staff_name}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right hidden sm:block">
                      <div className="font-medium">
                        {formatPrice(reservation.price || 0)}
                      </div>
                    </div>
                    {getStatusBadge(reservation.status)}
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Reservation Detail Dialog */}
      <Dialog open={isDetailOpen} onOpenChange={setIsDetailOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Calendar className="h-5 w-5" />
              予約詳細
            </DialogTitle>
          </DialogHeader>

          {selectedReservation && (
            <div className="space-y-4 py-2">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">日時</span>
                  <span className="font-medium">
                    {formatDate(selectedReservation.start_at, "time")}〜{formatDate(selectedReservation.end_at, "time")}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">お客様</span>
                  <span className="font-medium">
                    {selectedReservation.customer_name}
                    {selectedReservation.customer_visit_count === 0 && (
                      <span className="ml-1 text-xs text-emerald-600 font-normal">新規</span>
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">メニュー</span>
                  <span className="font-medium">{selectedReservation.menu_name}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">担当</span>
                  <span className="font-medium">{selectedReservation.staff_name}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">料金</span>
                  <span className="font-medium">{formatPrice(selectedReservation.price || 0)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">ステータス</span>
                  {getStatusBadge(selectedReservation.status)}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">予約経路</span>
                  {getSourceBadge(selectedReservation.source)}
                </div>
              </div>

              {/* Action Buttons */}
              {selectedReservation.status === "pending" && (
                <div className="border-t pt-4 flex gap-2">
                  <Button
                    className="flex-1"
                    variant="outline"
                    onClick={() => handleConfirm(selectedReservation.id)}
                  >
                    <Check className="h-4 w-4 mr-2" />
                    予約を確定
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => handleCancel(selectedReservation.id)}
                  >
                    <X className="h-4 w-4 mr-2" />
                    キャンセル
                  </Button>
                </div>
              )}

              {/* Message Button */}
              <div className="border-t pt-4">
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => openChatModal(selectedReservation.customer_id)}
                >
                  <MessageCircle className="h-4 w-4 mr-2" />
                  メッセージを送る
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Chat Modal */}
      <Dialog open={isChatModalOpen} onOpenChange={setIsChatModalOpen}>
        <DialogContent className="max-w-md max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5" />
              {selectedReservation?.customer_name}さんとのメッセージ
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-auto min-h-[300px] max-h-[400px] p-2 border rounded-lg bg-muted/30">
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
                        {message.direction === "outgoing" && (message.sent_by_staff_name || message.staff_name) && (
                          <span className="ml-1">{message.sent_by_staff_name || message.staff_name}</span>
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

          <div className="space-y-3 pt-2">
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
                id="dashboardSendToLine"
                checked={sendToLine}
                onCheckedChange={(checked) => setSendToLine(checked === true)}
              />
              <label
                htmlFor="dashboardSendToLine"
                className="text-sm text-muted-foreground cursor-pointer"
              >
                公式LINEからも送信する
              </label>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
