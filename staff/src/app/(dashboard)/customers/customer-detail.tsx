"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Phone,
  Mail,
  Edit,
  Calendar,
  FileText,
  ClipboardList,
  ChevronRight,
  Plus,
  ImageIcon,
  Loader2,
  FileCheck,
  MessageSquare,
  Send,
} from "lucide-react";
import {
  customers,
  karutes,
  messages as messagesApi,
  staffApi,
  type Customer,
  type AssignedStaff,
  type Reservation,
  type Karute,
  type Staff,
  type Message,
} from "@/lib/api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate, formatPrice, cn } from "@/lib/utils";
import { useStore } from "@/contexts/store-context";
import { CounselingSheetForm } from "@/components/counseling-sheet-form";

type CustomerFormData = {
  name: string;
  name_kana: string;
  gender: "male" | "female" | "other" | "";
  phone: string;
  email: string;
  memo: string;
};

export default function CustomerDetail({ id, defaultTab = "karutes", backPath = "/customers", onClose }: { id: string; defaultTab?: string; backPath?: string; onClose?: () => void }) {
  const router = useRouter();
  const { currentStore, stores } = useStore();

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [assignedStaffList, setAssignedStaffList] = useState<AssignedStaff[]>([]);
  const [linkedCustomers, setLinkedCustomers] = useState<{
    id: string; store_id: string; store_name: string; name: string;
    visit_count: number | null; last_visit_at: string | null;
    staff_name: string | null; karute_count: number; last_reservation_at: string | null;
  }[]>([]);
  const [reservationList, setReservationList] = useState<Reservation[]>([]);
  const [karuteList, setKaruteList] = useState<Karute[]>([]);
  const [loading, setLoading] = useState(true);

  const [showEditDialog, setShowEditDialog] = useState(false);
  const [formData, setFormData] = useState<CustomerFormData>({
    name: "", name_kana: "", gender: "", phone: "", email: "", memo: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [creatingKarute, setCreatingKarute] = useState(false);
  const [ocrCreating, setOcrCreating] = useState<string | null>(null); // null | "reading" | "creating:N"
  const ocrFileInputRef = useRef<HTMLInputElement>(null);
  const [editStaffList, setEditStaffList] = useState<Staff[]>([]);
  const [editStaffIds, setEditStaffIds] = useState<string[]>([]);
  const [staffStoreMap, setStaffStoreMap] = useState<Map<string, string[]>>(new Map());
  const [staffFilterStore, setStaffFilterStore] = useState<string>("all");
  const [consentRecords, setConsentRecords] = useState<Array<{ id: string; customer_name: string; customer_birthday?: string; customer_phone?: string; template_snapshot?: string; created_at: string }>>([]);
  const [showConsentDialog, setShowConsentDialog] = useState(false);
  const [messageList, setMessageList] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messageText, setMessageText] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [sendToLine, setSendToLine] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const fetchCustomer = useCallback(async () => {
    if (id === "placeholder") return;
    setLoading(true);
    try {
      const data = await customers.get(id);
      setCustomer(data.customer);
      setAssignedStaffList(data.assigned_staff || []);
      setReservationList(data.reservations as Reservation[]);
      setKaruteList(data.karutes as Karute[]);
      setConsentRecords((data as any).consent_records || []);
      setLinkedCustomers((data as any).linked_customers || []);
    } catch (error) {
      console.error("Failed to fetch customer:", error);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchCustomer();
  }, [fetchCustomer]);

  const handleEdit = async () => {
    if (!customer) return;
    setFormData({
      name: customer.name || "",
      name_kana: customer.name_kana || "",
      gender: (customer.gender as CustomerFormData["gender"]) || "",
      phone: customer.phone || "",
      email: customer.email || "",
      memo: customer.memo || "",
    });
    // Use customer_staff junction table, fallback to legacy staff_id
    const staffIds = assignedStaffList.length > 0
      ? assignedStaffList.map(s => s.staff_id)
      : (customer.staff_id ? [customer.staff_id] : []);
    setEditStaffIds(staffIds);
    try {
      // Fetch staff from all stores before showing dialog
      const allStaff: Staff[] = [];
      const storeMap = new Map<string, string[]>();
      for (const store of stores) {
        const data = await staffApi.list(store.id);
        for (const s of data.staff) {
          if (!s.is_active) continue;
          if (!allStaff.some(a => a.id === s.id)) allStaff.push(s);
          const existing = storeMap.get(s.id) || [];
          existing.push(store.id);
          storeMap.set(s.id, existing);
        }
      }
      setEditStaffList(allStaff);
      setStaffStoreMap(storeMap);
      setStaffFilterStore("all");
    } catch { /* ignore */ }
    setShowEditDialog(true);
  };

  const handleSave = async () => {
    if (!customer || !formData.name.trim()) return;
    setSubmitting(true);
    try {
      const { customer: updated } = await customers.update(customer.id, {
        name: formData.name,
        name_kana: formData.name_kana || null,
        gender: formData.gender || null,
        phone: formData.phone || null,
        email: formData.email || null,
        memo: formData.memo || null,
      });
      // Update assigned staff if changed
      const currentStaffIds = assignedStaffList.map(s => s.staff_id).sort().join(',');
      const newStaffIds = [...editStaffIds].sort().join(',');
      if (newStaffIds !== currentStaffIds) {
        const { customer: staffUpdated } = await customers.assignStaffMultiple(customer.id, editStaffIds);
        setCustomer(staffUpdated);
        const refreshed = await customers.get(customer.id);
        setAssignedStaffList(refreshed.assigned_staff || []);
      } else {
        setCustomer(updated);
      }
      setShowEditDialog(false);
    } catch (error) {
      console.error("Failed to update:", error);
      alert(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateKarute = async () => {
    if (!customer || !currentStore || creatingKarute) return;
    setCreatingKarute(true);
    try {
      const today = new Date();
      const visitDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const { karute } = await karutes.create({
        store_id: currentStore.id,
        customer_id: customer.id,
        visit_date: visitDate,
      });
      window.location.href = `/customers/karutes/${karute.id}`;
    } catch (error) {
      console.error("Failed to create karute:", error);
    } finally {
      setCreatingKarute(false);
    }
  };

  const handleOcrCreateKarutes = useCallback(async (file: File) => {
    if (!customer || !currentStore) return;
    setOcrCreating("reading");
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const { visits } = await karutes.extractDates(base64, file.type);
      if (!visits || visits.length === 0) {
        setOcrCreating(null);
        return;
      }

      setOcrCreating(`creating:${visits.length}`);
      for (const visit of visits) {
        await karutes.create({
          store_id: currentStore.id,
          customer_id: customer.id,
          visit_date: visit.date,
          menu_content: [visit.time, visit.description].filter(Boolean).join(" ") || null,
        });
      }
      await fetchCustomer();
    } catch (error) {
      console.error("Failed to create karutes from image:", error);
    } finally {
      setOcrCreating(null);
    }
  }, [customer, currentStore, fetchCustomer]);

  const fetchMessages = useCallback(async () => {
    if (!customer) return;
    setMessagesLoading(true);
    try {
      const data = await messagesApi.get(customer.id, currentStore?.id);
      setMessageList(data.messages || []);
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    } catch (error) {
      console.error("Failed to fetch messages:", error);
    } finally {
      setMessagesLoading(false);
    }
  }, [customer, currentStore?.id]);

  const handleSendMessage = async () => {
    if (!customer || !messageText.trim() || sendingMessage) return;
    setSendingMessage(true);
    try {
      await messagesApi.send(customer.id, messageText.trim(), sendToLine, currentStore?.id);
      setMessageText("");
      await fetchMessages();
    } catch (error) {
      console.error("Failed to send message:", error);
    } finally {
      setSendingMessage(false);
    }
  };

  const getStatusBadge = (status: Reservation["status"]) => {
    switch (status) {
      case "pending": return <Badge variant="warning">確認待ち</Badge>;
      case "confirmed": return <Badge variant="success">確定</Badge>;
      case "completed": return <Badge variant="secondary">完了</Badge>;
      case "cancelled": return <Badge variant="destructive">キャンセル</Badge>;
      case "noshow": return <Badge variant="destructive">無断キャンセル</Badge>;
      default: return <Badge>{status}</Badge>;
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  if (!customer) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => onClose ? onClose() : router.push(backPath)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          顧客一覧に戻る
        </Button>
        <div className="py-8 text-center text-muted-foreground">顧客が見つかりません</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => onClose ? onClose() : router.push(backPath)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-xl font-bold">
              {customer.name}
              {customer.is_minimo === 1 && (
                <span className="ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium text-white" style={{ backgroundColor: "#00A7FF" }}>minimo</span>
              )}
            </h1>
            {customer.name_kana && (
              <p className="text-sm text-muted-foreground">{customer.name_kana}</p>
            )}
            {customer.member_no && (
              <p className="text-xs text-muted-foreground font-mono mt-0.5">会員番号: {customer.member_no}</p>
            )}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={handleEdit}>
          <Edit className="mr-2 h-4 w-4" />
          編集
        </Button>
      </div>

      {/* Customer Info */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="flex items-center gap-2">
              <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
              <span>{customer.phone || "未設定"}</span>
            </div>
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="truncate">{customer.email || "未設定"}</span>
            </div>
          </div>
          <Separator />
          <div className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <span className="text-muted-foreground">性別</span>
              <div className="font-medium">
                {customer.gender === "male" ? "男性" : customer.gender === "female" ? "女性" : customer.gender === "other" ? "その他" : "未設定"}
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">来店回数</span>
              <div className="font-medium">{customer.visit_count}回</div>
            </div>
            <div>
              <span className="text-muted-foreground">最終来店</span>
              <div className="font-medium">
                {customer.last_visit_at ? formatDate(customer.last_visit_at, "short") : "なし"}
              </div>
            </div>
          </div>
          <Separator />
          <div className="text-sm flex items-center justify-between">
            <div>
              <span className="text-muted-foreground">担当: </span>
              <span className="font-medium">
                {assignedStaffList.length > 0
                  ? assignedStaffList.map(s => s.staff_name).join(", ")
                  : customer.staff_name || "未割当"}
              </span>
            </div>
            {consentRecords.length > 0 && (
              <Badge
                variant="success"
                className="cursor-pointer"
                onClick={() => setShowConsentDialog(true)}
              >
                <FileCheck className="mr-1 h-3 w-3" />同意済み
              </Badge>
            )}
          </div>
          <Separator />
          <div className="text-sm flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">minimo顧客</span>
              <span className="text-xs text-muted-foreground">(ONでLINE自動通知を停止)</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={customer.is_minimo === 1}
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
                customer.is_minimo === 1 ? "bg-sky-500" : "bg-input"
              )}
              onClick={async () => {
                const newVal = customer.is_minimo === 1 ? 0 : 1;
                try {
                  const { customer: updated } = await customers.update(customer.id, { is_minimo: newVal } as any);
                  setCustomer(updated);
                } catch (e) { console.error(e); }
              }}
            >
              <span className={cn(
                "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
                customer.is_minimo === 1 ? "translate-x-4" : "translate-x-0"
              )} />
            </button>
          </div>
          {customer.memo && (
            <>
              <Separator />
              <div className="text-sm">
                <span className="text-muted-foreground">メモ</span>
                <div className="mt-1 whitespace-pre-wrap rounded-md bg-muted p-2 text-sm">
                  {customer.memo}
                </div>
              </div>
            </>
          )}
        {linkedCustomers.length > 0 && (
            <>
              <Separator />
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">同一会員番号のリンク済みレコード（他店舗含む）</p>
                {linkedCustomers.map((lc) => (
                  <div key={lc.id} className="rounded-md border p-2 text-xs space-y-0.5">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{lc.store_name}</span>
                      <span className="text-muted-foreground">来店{lc.visit_count || 0}回</span>
                    </div>
                    <div className="text-muted-foreground">
                      {lc.staff_name && <span>担当: {lc.staff_name}　</span>}
                      {lc.last_visit_at && <span>最終来店: {lc.last_visit_at.slice(0, 10)}</span>}
                      {!lc.last_visit_at && lc.last_reservation_at && <span>直近予約: {lc.last_reservation_at.slice(0, 10)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs defaultValue={defaultTab}>
        <TabsList className="w-full grid grid-cols-4">
          <TabsTrigger value="reservations" className="text-xs sm:text-sm">
            <Calendar className="mr-1 h-3 w-3 sm:h-4 sm:w-4" />
            <span className="hidden sm:inline">予約履歴</span>
            <span className="sm:hidden">予約</span>
          </TabsTrigger>
          <TabsTrigger value="karutes" className="text-xs sm:text-sm">
            <FileText className="mr-1 h-3 w-3 sm:h-4 sm:w-4" />
            カルテ
          </TabsTrigger>
          <TabsTrigger value="messages" className="text-xs sm:text-sm" onClick={() => { if (messageList.length === 0 && !messagesLoading) fetchMessages(); }}>
            <MessageSquare className="mr-1 h-3 w-3 sm:h-4 sm:w-4" />
            <span className="hidden sm:inline">メッセージ</span>
            <span className="sm:hidden">MSG</span>
          </TabsTrigger>
          <TabsTrigger value="counseling" className="text-xs sm:text-sm">
            <ClipboardList className="mr-1 h-3 w-3 sm:h-4 sm:w-4" />
            <span className="hidden sm:inline">カウンセリング</span>
            <span className="sm:hidden">問診</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="reservations" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">予約履歴</CardTitle>
              <CardDescription>{reservationList.length}件</CardDescription>
            </CardHeader>
            <CardContent>
              {reservationList.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">予約履歴がありません</div>
              ) : (
                <div className="space-y-3">
                  {reservationList.map((reservation) => (
                    <div key={reservation.id} className="rounded-lg border p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-sm">
                            {formatDate(reservation.start_at, "datetime")}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {reservation.menu_name} / {reservation.staff_name}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          {getStatusBadge(reservation.status)}
                          <span className="text-sm font-medium">{formatPrice(reservation.price || 0)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="karutes" className="mt-4 space-y-3">
          <input
            ref={ocrFileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleOcrCreateKarutes(file);
              e.target.value = "";
            }}
          />
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold">カルテ</h3>
              <p className="text-sm text-muted-foreground">{karuteList.length}件</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => ocrFileInputRef.current?.click()}
                disabled={ocrCreating !== null}
              >
                {ocrCreating ? (
                  <>
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    {ocrCreating === "reading"
                      ? "読み込み中..."
                      : `${ocrCreating.split(":")[1]}件作成中...`}
                  </>
                ) : (
                  <>
                    <ImageIcon className="mr-1 h-4 w-4" />
                    画像から作成
                  </>
                )}
              </Button>
              <Button size="sm" onClick={handleCreateKarute} disabled={creatingKarute}>
                <Plus className="mr-1 h-4 w-4" />
                {creatingKarute ? "作成中..." : "新規作成"}
              </Button>
            </div>
          </div>
          {karuteList.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">カルテがありません</div>
          ) : (
            <div className="space-y-3">
              {karuteList.map((karute) => (
                <Card
                  key={karute.id}
                  className="transition-colors hover:bg-accent cursor-pointer"
                  onClick={() => window.location.href = `/customers/karutes/${karute.id}`}
                >
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="font-medium">{formatDate(karute.visit_date, "date")}</div>
                        {karute.store_name ? (
                          <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">{karute.store_name}</Badge>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        {karute.has_consent ? (
                          <Badge variant="success"><FileCheck className="mr-1 h-3 w-3" />同意済み</Badge>
                        ) : null}
                        {karute.is_shared_to_customer ? (
                          <Badge variant="success">共有済み</Badge>
                        ) : (
                          <Badge variant="outline">未共有</Badge>
                        )}
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      {karute.menu_content || "施術内容なし"}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      担当: {karute.staff_name}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="messages" className="mt-4">
          <Card>
            <CardContent className="p-4">
              {messagesLoading ? (
                <div className="py-8 text-center text-muted-foreground">読み込み中...</div>
              ) : messageList.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">メッセージがありません</div>
              ) : (
                <div className="space-y-3 max-h-[400px] overflow-y-auto p-1">
                  {messageList.map((msg) => (
                    <div
                      key={msg.id}
                      className={cn(
                        "flex",
                        msg.direction === "outgoing" ? "justify-end" : "justify-start"
                      )}
                    >
                      <div
                        className={cn(
                          "max-w-[80%] rounded-lg px-3 py-2 text-sm",
                          msg.direction === "outgoing"
                            ? "bg-primary text-primary-foreground"
                            : msg.direction === "system"
                            ? "bg-muted text-muted-foreground text-xs text-center w-full"
                            : "bg-muted"
                        )}
                      >
                        {msg.direction === "incoming" && (
                          <div className="text-xs text-muted-foreground mb-1">
                            {msg.source === "line" ? "LINE" : "Web"}
                          </div>
                        )}
                        <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                        <div className={cn(
                          "text-[10px] mt-1",
                          msg.direction === "outgoing" ? "text-primary-foreground/70" : "text-muted-foreground"
                        )}>
                          {formatDate(msg.sent_at, "datetime")}
                          {msg.direction === "outgoing" && msg.sent_by_staff_name && (
                            <span className="ml-1">({msg.sent_by_staff_name})</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
              )}
              <div className="mt-4 space-y-2">
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sendToLine}
                      onChange={(e) => setSendToLine(e.target.checked)}
                      className="rounded"
                    />
                    LINEにも送信
                  </label>
                </div>
                <div className="flex gap-2">
                  <Textarea
                    value={messageText}
                    onChange={(e) => setMessageText(e.target.value)}
                    placeholder="メッセージを入力..."
                    rows={2}
                    className="resize-none"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        handleSendMessage();
                      }
                    }}
                  />
                  <Button
                    size="icon"
                    onClick={handleSendMessage}
                    disabled={sendingMessage || !messageText.trim()}
                    className="shrink-0 self-end"
                  >
                    {sendingMessage ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="counseling" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">カウンセリングシート</CardTitle>
              <CardDescription>事前問診・ご要望</CardDescription>
            </CardHeader>
            <CardContent>
              <CounselingSheetForm
                customerId={customer.id}
                storeId={customer.store_id}
                embedded
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Edit Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle>顧客情報を編集</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-2">
              <Label>名前 <span className="text-destructive">*</span></Label>
              <Input placeholder="例: 山田 花子" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} />
              <p className="text-xs text-muted-foreground">姓と名の間にスペースを入れてください</p>
            </div>
            <div className="space-y-2">
              <Label>よみがな</Label>
              <Input placeholder="例: ヤマダ ハナコ" value={formData.name_kana} onChange={(e) => setFormData({ ...formData, name_kana: e.target.value })} />
              <p className="text-xs text-muted-foreground">姓と名の間にスペースを入れてください</p>
            </div>
            <div className="space-y-2">
              <Label>性別</Label>
              <div className="flex gap-3">
                {([
                  { value: "female", label: "女性" },
                  { value: "male", label: "男性" },
                  { value: "other", label: "その他" },
                ] as const).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={cn(
                      "flex-1 rounded-md border px-3 py-2 text-sm transition-colors",
                      formData.gender === option.value
                        ? "border-primary bg-primary/10 font-medium text-primary"
                        : "border-input hover:bg-muted/50"
                    )}
                    onClick={() =>
                      setFormData({
                        ...formData,
                        gender: formData.gender === option.value ? "" : option.value,
                      })
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>電話番号</Label>
                <Input
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>メール</Label>
                <Input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>担当スタッフ</Label>
              <div className="flex flex-wrap gap-1.5 min-h-[1.5rem]">
                {editStaffIds.map((sid) => {
                  const s = editStaffList.find(st => st.id === sid);
                  return (
                    <Badge key={sid} variant="secondary" className="cursor-pointer hover:bg-destructive/20"
                      onClick={() => setEditStaffIds(editStaffIds.filter(id => id !== sid))}>
                      {s ? (s.nickname || s.name) : (assignedStaffList.find(a => a.staff_id === sid)?.staff_name || (customer?.staff_id === sid ? (customer.staff_name || customer.staff_names) : null) || sid)} ×
                    </Badge>
                  );
                })}
              </div>
              {stores.length > 1 && (
                <div className="flex gap-1 flex-wrap">
                  <button
                    type="button"
                    onClick={() => setStaffFilterStore("all")}
                    className={cn("text-[10px] px-2 py-0.5 rounded-full border transition-colors", staffFilterStore === "all" ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-muted")}
                  >
                    全店舗
                  </button>
                  {stores.map((store) => (
                    <button
                      key={store.id}
                      type="button"
                      onClick={() => setStaffFilterStore(store.id)}
                      className={cn("text-[10px] px-2 py-0.5 rounded-full border transition-colors", staffFilterStore === store.id ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-muted")}
                    >
                      {store.name.replace(/^fein\./, "")}
                    </button>
                  ))}
                </div>
              )}
              <Select
                value=""
                onValueChange={(v) => {
                  if (v && !editStaffIds.includes(v)) {
                    setEditStaffIds([...editStaffIds, v]);
                  }
                }}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="+ スタッフを追加" />
                </SelectTrigger>
                <SelectContent>
                  {editStaffList
                    .filter((s) => !editStaffIds.includes(s.id) && (staffFilterStore === "all" || (staffStoreMap.get(s.id) || []).includes(staffFilterStore)))
                    .map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.nickname || s.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>メモ</Label>
              <Textarea
                value={formData.memo}
                onChange={(e) => setFormData({ ...formData, memo: e.target.value })}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>キャンセル</Button>
            <Button onClick={handleSave} disabled={submitting}>{submitting ? "保存中..." : "保存"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Consent Records Dialog */}
      <Dialog open={showConsentDialog} onOpenChange={setShowConsentDialog}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle>施術同意書</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Show consent content from first record's template snapshot */}
            {(() => {
              const withSnapshot = consentRecords.find(r => r.template_snapshot);
              if (!withSnapshot?.template_snapshot) return null;
              try {
                const snapshot = JSON.parse(withSnapshot.template_snapshot);
                return (
                  <div className="space-y-3">
                    {snapshot.title && <h3 className="font-semibold text-sm">{snapshot.title}</h3>}
                    {snapshot.sections?.map((section: { title: string; items: string[] }, i: number) => (
                      <div key={i} className="space-y-1">
                        <h4 className="text-sm font-medium">{section.title}</h4>
                        <ul className="space-y-0.5">
                          {section.items.map((item: string, j: number) => (
                            <li key={j} className="text-xs text-muted-foreground leading-relaxed pl-1">{item}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                );
              } catch { return null; }
            })()}

            {/* Consent submission records */}
            <Separator />
            <h3 className="font-semibold text-sm">同意記録</h3>
            {consentRecords.map((record) => (
              <div key={record.id} className="rounded-md border p-3 space-y-1 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{record.customer_name || customer?.name}</span>
                  <span className="text-xs text-muted-foreground">{formatDate(record.created_at, "datetime")}</span>
                </div>
                {record.customer_birthday && (
                  <div className="text-muted-foreground">生年月日: {record.customer_birthday}</div>
                )}
                {record.customer_phone && (
                  <div className="text-muted-foreground">電話番号: {record.customer_phone}</div>
                )}
              </div>
            ))}
            {consentRecords.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">同意書記録がありません</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
