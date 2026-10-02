"use client";

import { useEffect, useState, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  API_BASE_URL,
  getStoreId,
  setStoreId,
  tokenStorage,
  staffApi,
  storeApi,
  messagesApi,
  authApi,
  reservationsApi,
  type Message,
  type Staff,
  type Customer,
  type Reservation,
} from "@/lib/api";
import { initLiff, isInLiffBrowser, getLiffAccessToken, isLiffLoggedIn, liffLogin } from "@/lib/liff";
import { cn } from "@/lib/utils";
import { Send, ChevronLeft, User, MessageSquare, X, Calendar } from "lucide-react";

const GUEST_INFO_KEY = "guest_message_info";

function getGuestInfo(): { name: string; phone: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(GUEST_INFO_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveGuestInfo(name: string, phone: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(GUEST_INFO_KEY, JSON.stringify({ name, phone }));
}

export default function MessagesPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      }
    >
      <MessagesPageInner />
    </Suspense>
  );
}

function MessagesPageInner() {
  const searchParams = useSearchParams();
  const staffIdParam = searchParams.get("staff_id");
  const storeIdParam = searchParams.get("store_id");

  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [selectedStaff, setSelectedStaff] = useState<Staff | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [newMessage, setNewMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Guest info inline form
  const [showGuestForm, setShowGuestForm] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");

  // LIFF access token (for LINE in-app browser)
  const [liffAccessToken, setLiffAccessToken] = useState<string | null>(null);

  // Name registration for new LINE users
  const [needsNameRegistration, setNeedsNameRegistration] = useState(false);
  const [regName, setRegName] = useState("");
  const [regPhone, setRegPhone] = useState("");
  const [regSubmitting, setRegSubmitting] = useState(false);

  // Next reservation
  const [nextReservation, setNextReservation] = useState<Reservation | null>(null);

  // Load staff list and optionally customer data + silently init LIFF
  useEffect(() => {
    if (storeIdParam) {
      setStoreId(storeIdParam);
    }
    const fetchData = async () => {
      try {
        const staffData = await staffApi.list();
        setStaffList(staffData.staff);

        // Try to get customer data (may fail if not logged in)
        try {
          const authData = await authApi.me();
          setCustomer(authData.customer);
          if ((authData as any).line?.registration_status && (authData as any).line.registration_status !== 'completed') {
            setNeedsNameRegistration(true);
            setRegName(authData.customer.name || "");
          }
        } catch {
          // Not logged in — customer stays null
        }

        // Auto-select staff from URL param
        if (staffIdParam) {
          const matched = staffData.staff.find(
            (s: Staff) => s.id === staffIdParam
          );
          if (matched) {
            setSelectedStaff(matched);
          }
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();

    // Try to get LIFF access token (for LINE in-app browser)
    (async () => {
      // 1. Check sessionStorage first (saved by useLiffAuth on initial LIFF flow)
      const savedToken = sessionStorage.getItem("liff_access_token");
      if (savedToken) {
        setLiffAccessToken(savedToken);
        return;
      }

      // 2. Try liff.init() — works after LIFF redirect or in LINE in-app browser
      const initKey = "liff_init_on_messages";
      if (sessionStorage.getItem(initKey)) return;
      sessionStorage.setItem(initKey, "1");

      try {
        const storeData = await storeApi.get();
        const liffId = storeData.store?.line_liff_id;
        if (!liffId) return;
        const initialized = await initLiff(liffId);
        if (!initialized) return;

        // In LINE browser: if not logged in to LIFF, trigger login
        const isLineBrowser = /Line\//i.test(navigator.userAgent);
        if (isLineBrowser && !isLiffLoggedIn()) {
          liffLogin(window.location.href);
          return;
        }

        const token = getLiffAccessToken();
        if (token) {
          sessionStorage.setItem("liff_access_token", token);
          setLiffAccessToken(token);
        }
      } catch {
        // LIFF init failed - not in LIFF browser
      }
    })();
  }, [staffIdParam, storeIdParam]);

  // Authenticate with LIFF token if not logged in (so message history can load)
  useEffect(() => {
    if (customer || !liffAccessToken) return;

    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/customer/auth/liff`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            liff_access_token: liffAccessToken,
            store_id: getStoreId(),
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { token?: string };
          if (data.token) {
            tokenStorage.set(data.token);
            try {
              const authData = await authApi.me();
              setCustomer(authData.customer);
              if ((authData as any).line?.registration_status && (authData as any).line.registration_status !== 'completed') {
                setNeedsNameRegistration(true);
                setRegName(authData.customer.name || "");
              }
            } catch {
              // me() failed even with new token
            }
          }
        }
      } catch {
        // LIFF auth failed
      }
    })();
  }, [liffAccessToken, customer]);

  // Load messages when staff is selected. In the LINE/LIFF context, fetch by verified LINE
  // identity (liff-guest-history) so the history matches what was sent via the guest endpoint —
  // this works even when the authenticated customer token isn't present. Otherwise (web login)
  // use the authenticated endpoint. Both paths only ever return the requester's own messages.
  useEffect(() => {
    if (!selectedStaff) return;
    if (!liffAccessToken && !customer) return;
    const storeId = storeIdParam || getStoreId();
    const load = liffAccessToken
      ? messagesApi.listLiffGuest({
          store_id: storeId,
          staff_id: selectedStaff.id,
          liff_access_token: liffAccessToken,
        })
      : messagesApi.list(selectedStaff.id, storeId);
    load
      .then((data) => {
        setMessages(data.messages);
        if (customer) messagesApi.markAsRead().catch(console.error);
      })
      .catch(console.error);
  }, [selectedStaff?.id, customer, liffAccessToken, storeIdParam]);

  // Fetch next reservation for logged-in customer
  useEffect(() => {
    if (!customer) return;
    reservationsApi
      .list()
      .then((data) => {
        const now = new Date();
        const upcoming = data.reservations
          .filter((r) => {
            if (r.status === "cancelled") return false;
            const start = new Date(/Z|[+-]\d{2}:\d{2}$/.test(r.start_at) ? r.start_at : r.start_at.replace(" ", "T") + "Z");
            return start > now;
          })
          .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
        setNextReservation(upcoming[0] || null);
      })
      .catch(console.error);
  }, [customer]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendGuestMessage = async (content: string, name: string, phone: string) => {
    if (!selectedStaff) return;
    setSending(true);
    try {
      const result = await messagesApi.sendGuest({
        store_id: getStoreId(),
        staff_id: selectedStaff.id,
        content,
        name,
        phone,
      });
      setMessages((prev) => [...prev, result.message]);
      setNewMessage("");
      saveGuestInfo(name, phone);
      setShowGuestForm(false);
    } catch (err) {
      console.error(err);
      alert("送信に失敗しました");
    } finally {
      setSending(false);
    }
  };

  const sendLiffMessage = async (content: string) => {
    if (!selectedStaff || !liffAccessToken) return;
    setSending(true);
    try {
      const result = await messagesApi.sendLiffGuest({
        store_id: getStoreId(),
        staff_id: selectedStaff.id,
        content,
        liff_access_token: liffAccessToken,
      });
      setMessages((prev) => [...prev, result.message]);
      setNewMessage("");
    } catch (err) {
      console.error(err);
      alert("送信に失敗しました");
    } finally {
      setSending(false);
    }
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!newMessage.trim() || sending || !selectedStaff) return;

    // If logged in, send normally
    if (customer) {
      setSending(true);
      try {
        const result = await messagesApi.send(
          newMessage.trim(),
          selectedStaff.id,
          getStoreId()
        );
        setMessages((prev) => [...prev, result.message]);
        setNewMessage("");
      } catch (err) {
        console.error(err);
        alert("送信に失敗しました");
      } finally {
        setSending(false);
      }
      return;
    }

    // In LIFF browser — send with LIFF access token (no name/phone needed)
    if (liffAccessToken) {
      await sendLiffMessage(newMessage.trim());
      return;
    }

    // Not logged in — check if we have guest info saved
    const savedGuest = getGuestInfo();
    if (savedGuest) {
      await sendGuestMessage(newMessage.trim(), savedGuest.name, savedGuest.phone);
      return;
    }

    // Show inline guest info form
    setShowGuestForm(true);
  };

  const handleGuestSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!guestName.trim() || !guestPhone.trim() || !newMessage.trim()) return;
    await sendGuestMessage(newMessage.trim(), guestName.trim(), guestPhone.trim());
  };

  const handleBack = () => {
    setSelectedStaff(null);
    setMessages([]);
    setShowGuestForm(false);
  };

  const formatMessageTime = (date: string) => {
    // DB stores UTC timestamps like "2026-02-27 06:45:06" — parse as UTC
    const raw = /Z|[+-]\d{2}:\d{2}$/.test(date) ? date : date.replace(" ", "T") + "Z";
    const d = new Date(raw);
    const timeZone = "Asia/Tokyo";
    const now = new Date();
    const todayJST = now.toLocaleDateString("ja-JP", { timeZone });
    const dateJST = d.toLocaleDateString("ja-JP", { timeZone });
    const yesterday = new Date(now.getTime() - 86400000);
    const yesterdayJST = yesterday.toLocaleDateString("ja-JP", { timeZone });

    const time = d.toLocaleTimeString("ja-JP", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
    });

    if (dateJST === todayJST) return time;
    if (dateJST === yesterdayJST) return `昨日 ${time}`;
    return `${d.toLocaleDateString("ja-JP", { timeZone, month: "numeric", day: "numeric" })} ${time}`;
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  // Chat view
  if (selectedStaff) {
    return (
      <div className="flex h-screen flex-col pb-16">
        {/* Header */}
        <div className="border-b bg-background p-4">
          <div className="flex items-center gap-3">
            <button onClick={handleBack} className="text-muted-foreground">
              <ChevronLeft className="h-5 w-5" />
            </button>
            {selectedStaff.avatar_url ? (
              <img
                src={`${API_BASE_URL}${selectedStaff.avatar_url}`}
                alt={selectedStaff.name}
                className="h-10 w-10 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                <User className="h-5 w-5 text-primary" />
              </div>
            )}
            <div>
              <h1 className="font-medium">{selectedStaff.name}</h1>
              <p className="text-xs text-muted-foreground">
                営業時間内に返信いたします
              </p>
            </div>
          </div>
        </div>

        {/* Next reservation banner */}
        {nextReservation && (
          <div className="border-b bg-primary/5 px-4 py-2 flex items-center gap-2 text-sm">
            <Calendar className="h-4 w-4 text-primary shrink-0" />
            <span className="text-muted-foreground">次回予約:</span>
            <span className="font-medium">
              {(() => {
                const raw = /Z|[+-]\d{2}:\d{2}$/.test(nextReservation.start_at)
                  ? nextReservation.start_at
                  : nextReservation.start_at.replace(" ", "T") + "Z";
                const d = new Date(raw);
                const tz = "Asia/Tokyo";
                return d.toLocaleDateString("ja-JP", { timeZone: tz, month: "numeric", day: "numeric", weekday: "short" })
                  + " " + d.toLocaleTimeString("ja-JP", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
              })()}
            </span>
            {nextReservation.menu?.name && (
              <span className="text-muted-foreground truncate">
                {nextReservation.menu.name}
              </span>
            )}
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-center text-muted-foreground">
                メッセージはありません
                <br />
                ご質問やご要望をお気軽にお送りください
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((message) => {
                const isCustomer = message.sender_type === "customer";
                return (
                  <div
                    key={message.id}
                    className={cn(
                      "flex gap-2",
                      isCustomer ? "flex-row-reverse" : "flex-row"
                    )}
                  >
                    {!isCustomer && (
                      <Avatar className="h-8 w-8 shrink-0">
                        <AvatarImage
                          src={
                            message.sender?.avatar_url
                              ? `${API_BASE_URL}${message.sender.avatar_url}`
                              : undefined
                          }
                        />
                        <AvatarFallback className="text-xs">
                          {message.sender?.name?.charAt(0) || "S"}
                        </AvatarFallback>
                      </Avatar>
                    )}
                    <div
                      className={cn(
                        "max-w-[75%] space-y-1",
                        isCustomer ? "items-end" : "items-start"
                      )}
                    >
                      <div
                        className={cn(
                          "rounded-2xl px-4 py-2",
                          isCustomer
                            ? "rounded-br-md bg-primary text-primary-foreground"
                            : "rounded-bl-md bg-muted"
                        )}
                      >
                        <p className="text-sm whitespace-pre-wrap">
                          {message.content}
                        </p>
                      </div>
                      <p
                        className={cn(
                          "text-xs text-muted-foreground",
                          isCustomer ? "text-right" : "text-left"
                        )}
                      >
                        {formatMessageTime(message.sent_at)}
                      </p>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Name registration for new LINE users */}
        {needsNameRegistration && (
          <div className="border-t bg-primary/5 p-4 space-y-3">
            <p className="text-sm font-medium">はじめまして！お名前をご登録ください</p>
            <div className="flex gap-2">
              <Input
                value={regName}
                onChange={(e) => setRegName(e.target.value)}
                placeholder="お名前（フルネーム）"
                className="flex-1"
              />
              <Input
                type="tel"
                value={regPhone}
                onChange={(e) => setRegPhone(e.target.value)}
                placeholder="電話番号（任意）"
                className="flex-1"
              />
            </div>
            <Button
              className="w-full"
              disabled={!regName.trim() || regSubmitting}
              onClick={async () => {
                setRegSubmitting(true);
                try {
                  await fetch(`${API_BASE_URL}/api/customer/profile`, {
                    method: "PUT",
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${tokenStorage.get()}`,
                    },
                    body: JSON.stringify({
                      name: regName.trim(),
                      phone: regPhone.trim() || undefined,
                    }),
                  });
                  setNeedsNameRegistration(false);
                  // Refresh customer data
                  try {
                    const authData = await authApi.me();
                    setCustomer(authData.customer);
                  } catch {}
                } catch {
                  alert("登録に失敗しました");
                } finally {
                  setRegSubmitting(false);
                }
              }}
            >
              {regSubmitting ? "登録中..." : "登録する"}
            </Button>
          </div>
        )}

        {/* Bottom area: message input + guest form */}
        <div className="border-t bg-background">
          {showGuestForm ? (
            <form onSubmit={handleGuestSubmit} className="p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">お名前と電話番号を入力してください</p>
                <button
                  type="button"
                  onClick={() => setShowGuestForm(false)}
                  className="text-muted-foreground p-1"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex gap-2">
                <Input
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  placeholder="お名前"
                  required
                  autoComplete="name"
                  className="flex-1"
                />
                <Input
                  type="tel"
                  value={guestPhone}
                  onChange={(e) => setGuestPhone(e.target.value)}
                  placeholder="電話番号"
                  required
                  autoComplete="tel"
                  className="flex-1"
                />
              </div>
              <div className="flex gap-2 items-end">
                <textarea
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="メッセージを入力..."
                  rows={1}
                  className="flex-1 min-h-[40px] max-h-[120px] rounded-md border border-input bg-background px-3 py-2 text-sm resize-none"
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = Math.min(el.scrollHeight, 120) + "px";
                  }}
                />
                <Button
                  type="submit"
                  size="icon"
                  disabled={!newMessage.trim() || !guestName.trim() || !guestPhone.trim() || sending}
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex gap-2 p-4 items-end">
              <textarea
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                placeholder="メッセージを入力..."
                rows={1}
                className="flex-1 min-h-[40px] max-h-[120px] rounded-md border border-input bg-background px-3 py-2 text-sm resize-none"
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = Math.min(el.scrollHeight, 120) + "px";
                }}
              />
              <Button
                type="button"
                size="icon"
                disabled={!newMessage.trim() || sending}
                onClick={handleSend}
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Staff selection view
  return (
    <div className="min-h-screen bg-background p-4 space-y-4">
      <div>
        <h1 className="text-xl font-bold">メッセージ</h1>
        <p className="text-sm text-muted-foreground">
          スタッフを選んでメッセージを送れます
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {staffList.map((staff) => (
          <Card
            key={staff.id}
            className="cursor-pointer transition-all hover:border-primary/50"
            onClick={() => setSelectedStaff(staff)}
          >
            <CardContent className="flex flex-col items-center justify-center p-4 text-center">
              {staff.avatar_url ? (
                <img
                  src={`${API_BASE_URL}${staff.avatar_url}`}
                  alt={staff.name}
                  className="w-16 h-16 rounded-full object-cover mb-2"
                />
              ) : (
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                  <User className="h-8 w-8 text-primary" />
                </div>
              )}
              <span className="font-medium text-sm">{staff.name}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      {staffList.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <MessageSquare className="h-12 w-12 mb-2" />
          <p>スタッフが登録されていません</p>
        </div>
      )}
    </div>
  );
}
