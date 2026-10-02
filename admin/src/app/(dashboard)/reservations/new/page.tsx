"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ChevronLeft, Scissors, User, ChevronRight } from "lucide-react";
import { DateTimePicker, TimePicker } from "@/components/drum-picker";
import { reservations, staff as staffApi, type Staff } from "@/lib/api";
import { formatPrice, formatDuration } from "@/lib/utils";
import { useStore } from "@/contexts/store-context";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const SESSION_KEY = "admin_reservation_draft";

type SelectedMenu = { id: string; name: string; duration: number; price: number };

type DraftData = {
  customerId: string;
  customerName: string;
  selectedMenus: SelectedMenu[];
  date: string;
  startTime: string;
  endTime: string;
  memo: string;
  staffType: "free" | "designated";
  targetStaffId: string | null;
  source: "phone" | "walk-in" | "web" | "line" | "minimo";
  salonboardRoute: string;
};

function saveDraft(data: DraftData) {
  if (typeof window !== "undefined") {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
  }
}

function loadDraft(): DraftData | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DraftData;
  } catch {
    return null;
  }
}

function clearDraft() {
  if (typeof window !== "undefined") {
    sessionStorage.removeItem(SESSION_KEY);
  }
}

function getToday(): string {
  const now = new Date();
  const jstDate = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const y = jstDate.getFullYear();
  const m = String(jstDate.getMonth() + 1).padStart(2, "0");
  const d = String(jstDate.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function timeToMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function NewReservationContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { currentStore } = useStore();

  // Form state
  const [customerId, setCustomerId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [selectedMenus, setSelectedMenus] = useState<SelectedMenu[]>([]);
  const [date, setDate] = useState(getToday());
  const [startTime, setStartTime] = useState("10:00");
  const [endTime, setEndTime] = useState("11:00");
  const [memo, setMemo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [targetStaffId, setTargetStaffId] = useState<string | null>(null);
  const [staffType, setStaffType] = useState<"free" | "designated">("free");
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [source, setSource] = useState<"phone" | "walk-in" | "web" | "line" | "minimo">("phone");
  const [salonboardRoute, setSalonboardRoute] = useState("phone");

  const totalDuration = selectedMenus.reduce((s, m) => s + m.duration, 0);
  const totalPrice = selectedMenus.reduce((s, m) => s + m.price, 0);

  const calcEndTime = (start: string, durationMin: number): string => {
    return minToTime(timeToMin(start) + durationMin);
  };

  // Fetch staff list
  useEffect(() => {
    if (!currentStore) return;
    staffApi.list(currentStore.id).then((r) => {
      setStaffList(r.staff.filter((s) => s.is_active));
    }).catch(() => {});
  }, [currentStore]);

  // Initialize from search params + sessionStorage
  useEffect(() => {
    const paramDate = searchParams.get("date");
    const paramTime = searchParams.get("time");
    const paramStaffId = searchParams.get("staff_id");
    const paramCustomerId = searchParams.get("customer_id");
    const paramCustomerName = searchParams.get("customer_name");
    const paramMenuData = searchParams.get("menu_data");

    if (paramStaffId) {
      setTargetStaffId(paramStaffId);
      setStaffType("designated");
    }

    const draft = loadDraft();
    const isReturningFromSelection =
      (paramCustomerId && paramCustomerName) || paramMenuData;

    if (isReturningFromSelection) {
      // Returning from customer selection
      if (paramCustomerId && paramCustomerName) {
        setCustomerId(paramCustomerId);
        setCustomerName(decodeURIComponent(paramCustomerName));
      }
      // Returning from menu selection
      let newMenus: SelectedMenu[] = [];
      if (paramMenuData) {
        try {
          newMenus = JSON.parse(decodeURIComponent(paramMenuData));
          setSelectedMenus(newMenus);
        } catch { /* ignore */ }
      }

      // Restore remaining form state from draft
      if (draft) {
        if (!paramCustomerId) {
          setCustomerId(draft.customerId || "");
          setCustomerName(draft.customerName || "");
        }
        if (!paramMenuData) {
          setSelectedMenus(draft.selectedMenus || []);
        }
        setDate(draft.date);
        setStartTime(draft.startTime);
        setMemo(draft.memo);
        setSource(draft.source || "phone");
        setSalonboardRoute(draft.salonboardRoute || "phone");
        if (!paramStaffId) {
          setStaffType(draft.staffType || "free");
          setTargetStaffId(draft.targetStaffId || null);
        }

        // Recalculate end time if returning from menu selection
        if (paramMenuData && newMenus.length > 0) {
          const dur = newMenus.reduce((s, m) => s + m.duration, 0);
          setEndTime(calcEndTime(draft.startTime, dur));
        } else {
          setEndTime(draft.endTime);
        }
        clearDraft();
      }
      return;
    }

    // Otherwise, set from query params (initial visit)
    if (paramDate) setDate(paramDate);
    if (paramTime) {
      setStartTime(paramTime);
      const [h, m] = paramTime.split(":").map(Number);
      setEndTime(`${(h + 1).toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const buildDraft = (): DraftData => ({
    customerId,
    customerName,
    selectedMenus,
    date,
    startTime,
    endTime,
    memo,
    staffType,
    targetStaffId,
    source,
    salonboardRoute,
  });

  // Navigate to customer selection
  const handleSelectCustomer = () => {
    saveDraft(buildDraft());
    router.push("/customers?mode=select");
  };

  // Navigate to menu selection
  const handleSelectMenu = () => {
    saveDraft(buildDraft());
    const effectiveStaffId = staffType === "designated" && targetStaffId ? targetStaffId : undefined;
    const selectedParam = selectedMenus.length > 0
      ? `&selected=${encodeURIComponent(JSON.stringify(selectedMenus))}`
      : "";
    router.push(`/menus/select${effectiveStaffId ? `?staff_id=${effectiveStaffId}` : "?"}${selectedParam}`);
  };

  // Create reservation
  const handleCreate = async () => {
    if (!currentStore || !customerId || selectedMenus.length === 0 || !endTime) return;

    // If staff type is designated but no staff selected, show error
    if (staffType === "designated" && !targetStaffId) {
      alert("指名の場合はスタッフを選択してください");
      return;
    }

    // If staff type is free but no staff available, show error
    if (staffType === "free" && staffList.length === 0) {
      alert("スタッフが登録されていません");
      return;
    }

    setSubmitting(true);
    try {
      const startAt = new Date(`${date}T${startTime}:00+09:00`);
      const endAt = new Date(`${date}T${endTime}:00+09:00`);

      // If staff type is free, pick the first available staff
      let staffId = targetStaffId || "";
      if (staffType === "free") {
        staffId = staffList[0].id;
      }

      await reservations.create({
        store_id: currentStore.id,
        customer_id: customerId,
        staff_id: staffId,
        menu_id: selectedMenus[0].id,
        menu_ids: selectedMenus.map(m => m.id),
        menu_data: selectedMenus.map(m => ({ id: m.id, name: m.name, duration: m.duration, price: m.price })),
        start_at: startAt.toISOString(),
        end_at: endAt.toISOString(),
        memo: memo || null,
        source,
        salonboard_route: salonboardRoute || undefined,
      });

      clearDraft();
      router.push("/reservations");
    } catch (error) {
      console.error("Failed to create reservation:", error);
      alert(error instanceof Error ? error.message : "予約の作成に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto space-y-4 overflow-x-hidden">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => router.push("/reservations")}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl font-bold">新規予約作成</h1>
      </div>

      {/* Customer */}
      <div className="space-y-2">
        <Label>顧客</Label>
        {customerId ? (
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">{customerName}</span>
            </div>
            <Button variant="outline" size="sm" onClick={handleSelectCustomer}>
              変更
            </Button>
          </div>
        ) : (
          <Button variant="outline" className="w-full justify-start gap-2" onClick={handleSelectCustomer}>
            <User className="h-4 w-4" />
            顧客を選択
          </Button>
        )}
      </div>

      {/* Staff Type */}
      <div className="space-y-2">
        <Label>担当スタッフ</Label>
        <Tabs value={staffType} onValueChange={(v) => {
          const val = v as "free" | "designated";
          setStaffType(val);
          if (val === "free") {
            setTargetStaffId(null);
            setSelectedMenus([]);
          }
        }}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="free">フリー</TabsTrigger>
            <TabsTrigger value="designated">指名</TabsTrigger>
          </TabsList>
        </Tabs>
        {staffType === "designated" && (
          <Select
            value={targetStaffId || ""}
            onValueChange={(v) => {
              setTargetStaffId(v);
              setSelectedMenus([]);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="スタッフを選択" />
            </SelectTrigger>
            <SelectContent>
              {staffList.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Menu */}
      <div className="space-y-2">
        <Label>メニュー</Label>
        {selectedMenus.length > 0 ? (
          <div className="rounded-md border">
            {selectedMenus.map((m, i) => (
              <div key={m.id} className={`flex items-center gap-2 p-2.5 ${i < selectedMenus.length - 1 ? "border-b" : ""}`}>
                <Scissors className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium leading-tight break-words">{m.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDuration(m.duration)} / {formatPrice(m.price)}
                  </p>
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between border-t bg-muted/30 px-3 py-2">
              <span className="text-xs text-muted-foreground">
                合計: {formatDuration(totalDuration)} / {formatPrice(totalPrice)}
              </span>
              <Button variant="outline" size="sm" onClick={handleSelectMenu}>
                変更
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" className="w-full justify-between gap-2" onClick={handleSelectMenu}>
            <span className="flex items-center gap-2">
              <Scissors className="h-4 w-4" />
              メニューを選択
            </span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </Button>
        )}
      </div>

      {/* Date + Start Time */}
      <div className="space-y-2">
        <Label>開始日時</Label>
        <DateTimePicker
          date={date}
          time={startTime}
          onDateChange={setDate}
          onTimeChange={(t) => {
            setStartTime(t);
            if (totalDuration > 0) {
              setEndTime(minToTime(timeToMin(t) + totalDuration));
            }
          }}
          label="開始日時"
        />
      </div>

      {/* End Time */}
      <div className="space-y-2">
        <Label>終了時間</Label>
        <TimePicker value={endTime} onChange={setEndTime} label="終了時間" />
        {selectedMenus.length > 0 && totalDuration > 0 && (() => {
          const diff = timeToMin(endTime) - timeToMin(startTime);
          if (diff !== totalDuration) {
            return <p className="text-xs text-muted-foreground">メニュー所要時間: {formatDuration(totalDuration)} → 変更済み: {formatDuration(diff)}</p>;
          }
          return null;
        })()}
      </div>

      {/* Source / Salonboard Route */}
      <div className="space-y-2">
        <Label>予約経路</Label>
        <Select
          value={salonboardRoute}
          onValueChange={(value: string) => {
            setSalonboardRoute(value);
            // Map salonboard route to internal source
            const routeSourceMap: Record<string, "phone" | "walk-in" | "web" | "line" | "minimo"> = {
              "phone": "phone", "phone-hpb": "phone", "walk-in": "walk-in", "web": "web",
              "minimo": "minimo", "nailie": "phone", "line": "line", "next-visit": "phone",
              "practice-model": "phone", "instagram": "phone", "friend": "phone", "fix": "phone",
            };
            setSource(routeSourceMap[value] || "phone");
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="phone">電話（自社）</SelectItem>
            <SelectItem value="phone-hpb">電話（HPB）</SelectItem>
            <SelectItem value="line">公式LINE</SelectItem>
            <SelectItem value="next-visit">次回予約</SelectItem>
            <SelectItem value="walk-in">直接来店</SelectItem>
            <SelectItem value="instagram">インスタ</SelectItem>
            <SelectItem value="minimo">minimo</SelectItem>
            <SelectItem value="nailie">ネイリー</SelectItem>
            <SelectItem value="friend">友人</SelectItem>
            <SelectItem value="practice-model">練習モデル</SelectItem>
            <SelectItem value="fix">お直し</SelectItem>
            <SelectItem value="web">Web</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Memo */}
      <div className="space-y-2">
        <Label>メモ</Label>
        <Textarea
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="予約に関するメモ..."
          rows={3}
        />
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-3 pt-2 pb-4">
        <Button className="w-full" onClick={handleCreate} disabled={submitting || !customerId || selectedMenus.length === 0 || !endTime}>
          {submitting ? "作成中..." : "新規予約を作成する"}
        </Button>
        <Button className="w-full" variant="ghost" onClick={() => router.push("/reservations")}>
          戻る
        </Button>
      </div>
    </div>
  );
}

export default function NewReservationPage() {
  return (
    <Suspense fallback={<div className="py-12 text-center text-muted-foreground">読み込み中...</div>}>
      <NewReservationContent />
    </Suspense>
  );
}
