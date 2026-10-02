"use client";

import { useEffect, useState, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Send, ArrowLeft, Bell, X, User } from "lucide-react";
import CustomerDetail from "@/app/(dashboard)/customers/customer-detail";
import { messages, type Conversation, type Message as MessageType, type Customer } from "@/lib/api";
import { useStore } from "@/contexts/store-context";
import { formatDate, cn } from "@/lib/utils";
import { isPushSupported, subscribePush, isSubscribed, getPermissionState } from "@/lib/push-notifications";

type SelectedConversation = {
  customerId: string;
};

function MessagesContent() {
  const searchParams = useSearchParams();
  const customerIdParam = searchParams.get("customer_id");
  const staffIdParam = searchParams.get("staff_id");
  const { currentStore } = useStore();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<SelectedConversation | null>(null);
  const [messageList, setMessageList] = useState<MessageType[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [lineInfo, setLineInfo] = useState<{ display_name: string; picture_url: string } | null>(null);
  const [convSearch, setConvSearch] = useState("");
  const [newMessage, setNewMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const [showPushBanner, setShowPushBanner] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [customerDetailOpen, setCustomerDetailOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (customerDetailOpen) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [customerDetailOpen]);

  const isSelectedConv = (conv: Conversation) =>
    selectedConversation !== null &&
    conv.customer_id === selectedConversation.customerId;

  useEffect(() => {
    // Reset selection when store changes
    setSelectedConversation(null);
    setMessageList([]);
    setCustomer(null);
    setLineInfo(null);

    const fetchConversations = async () => {
      if (!currentStore) return;
      setLoading(true);
      try {
        const { conversations: data } = await messages.conversations(false, mineOnly, currentStore.id);
        setConversations(data);
      } catch (error) {
        console.error("Failed to fetch conversations:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchConversations();
  }, [currentStore?.id, mineOnly]);

  // Auto-select conversation from URL parameter
  useEffect(() => {
    if (!customerIdParam || loading) return;
    // Find matching conversation
    const match = conversations.find((c) => c.customer_id === customerIdParam);
    if (match) {
      setSelectedConversation({ customerId: match.customer_id });
    } else {
      setSelectedConversation({ customerId: customerIdParam });
    }
  }, [customerIdParam, staffIdParam, conversations, loading]);

  useEffect(() => {
    if (!selectedConversation || !currentStore) return;
    const fetchMessages = async () => {
      try {
        const data = await messages.get(selectedConversation.customerId, currentStore.id);
        setMessageList(data.messages);
        setCustomer(data.customer);
        setLineInfo(data.line);
        await messages.markRead(selectedConversation.customerId, currentStore.id);
        window.dispatchEvent(new Event('messages-read'));
        setConversations((prev) =>
          prev.map((c) =>
            c.customer_id === selectedConversation.customerId
              ? { ...c, unread_count: 0 }
              : c
          )
        );
      } catch (error) {
        console.error("Failed to fetch messages:", error);
      }
    };
    fetchMessages();
  }, [selectedConversation?.customerId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messageList]);

  // Clear app badge when messages page is opened or app returns to foreground
  useEffect(() => {
    const clearBadge = () => {
      if ('clearAppBadge' in navigator) {
        (navigator as unknown as { clearAppBadge: () => Promise<void> }).clearAppBadge().catch(() => {});
      }
    };
    clearBadge();
    const onVisible = () => {
      if (document.visibilityState === 'visible') clearBadge();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Check push notification state
  useEffect(() => {
    if (!isPushSupported()) return;
    if (getPermissionState() === "denied") return;
    isSubscribed().then((subscribed) => {
      if (!subscribed) setShowPushBanner(true);
    });
  }, []);

  const handleEnablePush = async () => {
    setSubscribing(true);
    const success = await subscribePush();
    if (success) setShowPushBanner(false);
    setSubscribing(false);
  };

  const handleSend = async () => {
    if (!newMessage.trim() || !selectedConversation || sending) return;
    setSending(true);
    try {
      const { message } = await messages.send(
        selectedConversation.customerId,
        newMessage,
        true,
        currentStore?.id
      );
      setMessageList((prev) => [...prev, message]);
      setNewMessage("");
      // Reset textarea height
      const textarea = document.querySelector('textarea[placeholder="メッセージを入力..."]') as HTMLTextAreaElement;
      if (textarea) textarea.style.height = "auto";
    } catch (error) {
      console.error("Failed to send message:", error);
    } finally {
      setSending(false);
    }
  };

  const handleBack = () => {
    setSelectedConversation(null);
    setMessageList([]);
    setCustomer(null);
    setLineInfo(null);
  };

  const selectedConv = selectedConversation
    ? conversations.find((c) => isSelectedConv(c))
    : null;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100dvh-8rem)] md:h-[calc(100dvh-10rem)]">
      <h1 className="text-xl md:text-2xl font-bold mb-4 md:hidden">
        {selectedConversation ? (
          <button onClick={handleBack} className="flex items-center gap-2">
            <ArrowLeft className="h-5 w-5" />
            {customer?.name || "メッセージ"}
          </button>
        ) : (
          "メッセージ"
        )}
      </h1>
      <h1 className="text-2xl font-bold mb-4 hidden md:block">メッセージ</h1>

      {showPushBanner && (
        <div className="mb-3 rounded-lg border bg-card p-3 text-sm">
          <div className="flex items-start gap-3">
            <Bell className="h-4 w-4 text-primary shrink-0 mt-0.5" />
            <span className="flex-1">プッシュ通知を有効にすると、お客様からメッセージが届いた時に通知を受け取れます。</span>
          </div>
          <div className="flex gap-2 justify-end mt-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setShowPushBanner(false)}
            >
              後で
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={handleEnablePush}
              disabled={subscribing}
            >
              {subscribing ? "設定中..." : "有効にする"}
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 flex gap-4 min-h-0">
        <Card className={cn(
          "flex flex-col min-h-0",
          selectedConversation ? "hidden md:flex" : "flex",
          "w-full md:w-80 lg:w-96"
        )}>
          <CardHeader className="pb-3 flex-shrink-0">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base md:text-lg">会話一覧</CardTitle>
              <Button
                variant={mineOnly ? "default" : "outline"}
                size="sm"
                onClick={() => setMineOnly(!mineOnly)}
                className="text-xs h-7"
              >
                自分宛のみ
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto p-0">
            <div className="p-2 border-b">
              <input
                type="text"
                value={convSearch}
                onChange={(e) => setConvSearch(e.target.value)}
                placeholder="顧客名で検索..."
                className="w-full rounded-md border bg-background px-3 py-1.5 text-sm min-w-0 max-w-full appearance-none"
              />
            </div>
            {conversations.length === 0 ? (
              <div className="p-4 text-center text-muted-foreground">
                メッセージがありません
              </div>
            ) : (
              <div>
                {conversations.filter((conv) => !convSearch.trim() || (conv.customer_name || "").toLowerCase().includes(convSearch.trim().toLowerCase())).map((conv) => (
                  <button
                    key={conv.customer_id}
                    onClick={() => setSelectedConversation({
                      customerId: conv.customer_id,
                    })}
                    className={cn(
                      "flex w-full items-start gap-3 border-b p-3 md:p-4 text-left transition-colors hover:bg-accent",
                      isSelectedConv(conv) && "bg-accent"
                    )}
                  >
                    <Avatar className="h-10 w-10 flex-shrink-0">
                      {conv.customer_avatar && <AvatarImage src={conv.customer_avatar} />}
                      <AvatarFallback>{conv.customer_name.charAt(0)}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 overflow-hidden min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-medium truncate">{conv.customer_name}</span>
                          {conv.customer_staff_name && (
                            <Badge variant="secondary" className="flex-shrink-0 text-xs">
                              {conv.customer_staff_name}
                            </Badge>
                          )}
                        </div>
                        {conv.unread_count > 0 && (
                          <Badge variant="destructive" className="flex-shrink-0">
                            {conv.unread_count}
                          </Badge>
                        )}
                      </div>
                      <div className="truncate text-sm text-muted-foreground">
                        {conv.last_message_direction === "outgoing" && "あなた: "}
                        {conv.last_message || "メッセージなし"}
                      </div>
                      {conv.last_message_at && (
                        <div className="text-xs text-muted-foreground">
                          {formatDate(conv.last_message_at, "datetime")}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className={cn(
          "flex-1 flex flex-col min-h-0",
          selectedConversation ? "flex" : "hidden md:flex"
        )}>
          {selectedConversation ? (
            <>
              <CardHeader className="border-b py-3 flex-shrink-0">
                <div className="flex items-center gap-3">
                  <button onClick={handleBack} className="md:hidden">
                    <ArrowLeft className="h-5 w-5" />
                  </button>
                  <Avatar className="h-10 w-10">
                    {lineInfo?.picture_url && <AvatarImage src={lineInfo.picture_url} />}
                    <AvatarFallback>{customer?.name.charAt(0)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <CardTitle className="text-base md:text-lg truncate">{customer?.name}</CardTitle>
                    <div className="flex items-center gap-2">
                      {lineInfo && (
                        <p className="text-xs md:text-sm text-muted-foreground truncate">
                          LINE: {lineInfo.display_name}
                        </p>
                      )}
                    </div>
                  </div>
                  {customer && (
                    <button
                      onClick={() => setCustomerDetailOpen(true)}
                      className="text-xs text-primary font-medium px-3 py-1 rounded-full bg-white border border-primary/20 shadow-sm hover:shadow transition-shadow shrink-0"
                    >
                      顧客情報
                    </button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col overflow-hidden p-0 min-h-0">
                <div className="flex-1 overflow-auto p-3 md:p-4">
                  <div className="space-y-3 md:space-y-4">
                    {messageList.map((message) => (
                      message.direction === "system" ? (
                        <div key={message.id} className="flex justify-center">
                          <div className="rounded-lg bg-muted/60 border px-4 py-2 text-center max-w-[85%]">
                            <p className="whitespace-pre-wrap text-xs text-muted-foreground">{message.content}</p>
                            <p className="text-[10px] text-muted-foreground/60 mt-1">{formatDate(message.sent_at, "datetime")}</p>
                          </div>
                        </div>
                      ) : (
                      <div
                        key={message.id}
                        className={cn(
                          "flex flex-col",
                          message.direction === "outgoing" ? "items-end" : "items-start"
                        )}
                      >
                        {message.direction === "outgoing" && (message.sent_by_staff_name || message.staff_name) && (
                          <span className="text-xs text-muted-foreground mb-0.5 mr-1">{message.sent_by_staff_name || message.staff_name}</span>
                        )}
                        <div
                          className={cn(
                            "max-w-[85%] md:max-w-[70%] rounded-lg px-3 py-2 md:px-4",
                            message.direction === "outgoing"
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted"
                          )}
                        >
                          <p className="whitespace-pre-wrap text-sm md:text-base">{message.content}</p>
                          <div
                            className={cn(
                              "mt-1 text-xs flex items-center flex-wrap gap-1",
                              message.direction === "outgoing"
                                ? "text-primary-foreground/70"
                                : "text-muted-foreground"
                            )}
                          >
                            {message.direction === "outgoing" && message.is_read === 1 && (
                              <span className="text-[10px]">既読</span>
                            )}
                            {formatDate(message.sent_at, "time")}
                            {message.source === "line" && (
                              <Badge variant="outline" className="text-xs h-4 px-1">
                                LINE
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                      )
                    ))}
                    <div ref={messagesEndRef} />
                  </div>
                </div>
                <Separator />
                {lineInfo ? (
                  <div className="px-3 pt-2 md:px-4">
                    <p className="text-xs text-muted-foreground">LINEで送信されます</p>
                  </div>
                ) : (
                  <div className="px-3 pt-2 md:px-4">
                    <p className="text-xs text-amber-600 font-medium">⚠️ LINE未連携のため、お客様に通知は届きません</p>
                  </div>
                )}
                <div className="flex items-end gap-2 p-3 md:p-4 flex-shrink-0">
                  <textarea
                    placeholder="メッセージを入力..."
                    value={newMessage}
                    onChange={(e) => {
                      setNewMessage(e.target.value);
                      e.target.style.height = "auto";
                      e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
                    }}
                    onFocus={(e) => {
                      setTimeout(() => e.target.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
                    }}
                    rows={1}
                    className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                  <Button
                    onClick={handleSend}
                    disabled={!newMessage.trim() || sending}
                    size="icon"
                    className="flex-shrink-0"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </>
          ) : (
            <CardContent className="flex h-full items-center justify-center">
              <div className="text-muted-foreground">
                会話を選択してください
              </div>
            </CardContent>
          )}
        </Card>
      </div>
      {/* Customer Detail Bottom Sheet */}
      {customerDetailOpen && customer && (
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
                  id={customer.id}
                  onClose={() => setCustomerDetailOpen(false)}
                />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function MessagesPage() {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center"><div className="text-muted-foreground">読み込み中...</div></div>}>
      <MessagesContent />
    </Suspense>
  );
}
