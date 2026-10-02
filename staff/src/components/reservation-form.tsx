"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ChevronLeft, Scissors, Ban, User, ChevronRight } from "lucide-react";
import { DateTimePicker, TimePicker } from "@/components/drum-picker";
import { reservations, staffApi, type Staff } from "@/lib/api";
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

type SelectedMenu = { id: string; name: string; duration: number; price: number };

type DraftData = {
  customerId?: string;
  reservationId?: string;
  customerName: string;
  selectedMenus: SelectedMenu[];
  date: string;
  startTime: string;
  endTime: string;
  memo: string;
  staffType: "free" | "designated";
  targetStaffId: string | null;
};

function getSessionKey(mode: "new" | "edit") {
  return mode === "edit" ? "reservation_edit_draft" : "reservation_draft";
}

function saveDraft(mode: "new" | "edit", data: DraftData) {
  if (typeof window !== "undefined") {
    sessionStorage.setItem(getSessionKey(mode), JSON.stringify(data));
  }
}

function loadDraft(mode: "new" | "edit"): DraftData | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(getSessionKey(mode));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DraftData;
  } catch {
    return null;
  }
}

function clearDraft(mode: "new" | "edit") {
  if (typeof window !== "undefined") {
    sessionStorage.removeItem(getSessionKey(mode));
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

function toJSTDateAndTime(isoStr: string): { date: string; time: string } {
  const d = new Date(isoStr);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const date = jst.toISOString().slice(0, 10);
  const time = jst.toISOString().slice(11, 16);
  return { date, time };
}

function getReservationIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const idx = pathParts.indexOf("reservations");
  if (idx !== -1 && pathParts[idx + 1] && pathParts[idx + 1] !== "placeholder") {
    return pathParts[idx + 1];
  }
  return null;
}

type ReservationFormProps = {
  mode: "new" | "edit";
};

function ReservationFormContent({ mode }: ReservationFormProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { currentStore, staff } = useStore();

  const isEdit = mode === "edit";
  const [reservationId, setReservationId] = useState<string>(() => {
    return isEdit ? (getReservationIdFromUrl() || "") : "";
  });

  // Form state
  const [customerId, setCustomerId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [selectedMenus, setSelectedMenus] = useState<SelectedMenu[]>([]);
  const [date, setDate] = useState(() => {
    if (isEdit) return "";
    return searchParams.get("date") || getToday();
  });
  const [startTime, setStartTime] = useState(() => {
    return searchParams.get("time") || "10:00";
  });
  const [endTime, setEndTime] = useState(() => {
    const t = searchParams.get("time");
    if (t) {
      const [h, m] = t.split(":").map(Number);
      return `${(h + 1).toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
    }
    return "11:00";
  });
  const [memo, setMemo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [targetStaffId, setTargetStaffId] = useState<string | null>(null);
  const [staffType, setStaffType] = useState<"free" | "designated">("designated");
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [salonboardRoute, setSalonboardRoute] = useState("phone");
  const [customerType, setCustomerType] = useState<"auto" | "new" | "repeat">("auto");
  const [isNewCustomer, setIsNewCustomer] = useState<number | null>(null);
  const [loading, setLoading] = useState(isEdit);

  const totalDuration = selectedMenus.reduce((s, m) => s + m.duration, 0);
  const totalPrice = selectedMenus.reduce((s, m) => s + m.price, 0);

  const calcEndTime = (start: string, durationMin: number): string => {
    return minToTime(timeToMin(start) + durationMin);
  };


  const backPath = isEdit ? `/reservations/${reservationId}` : "/reservations";

  // Fetch staff list
  useEffect(() => {
    if (!currentStore) return;
    staffApi.list(currentStore.id).then((r) => {
      setStaffList(r.staff.filter((s) => s.is_active));
    }).catch(() => {});
  }, [currentStore]);

  // Pre-select logged-in staff when staff loads (new mode only)
  useEffect(() => {
    if (isEdit || !staff?.id || targetStaffId) return;
    setTargetStaffId(staff.id);
  }, [staff?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- EDIT MODE: Initialize from reservation data or draft ---
  useEffect(() => {
    if (!isEdit) return;

    const id = getReservationIdFromUrl() || "";
    if (id) setReservationId(id);

    const paramMenuData = searchParams.get("menu_data");
    const draft = loadDraft("edit");

    if (paramMenuData && draft && draft.reservationId === id) {
      let newMenus: SelectedMenu[] = [];
      try {
        newMenus = JSON.parse(decodeURIComponent(paramMenuData));
        setSelectedMenus(newMenus);
      } catch { /* ignore */ }

      setCustomerName(draft.customerName);
      setDate(draft.date);
      setStartTime(draft.startTime);
      setMemo(draft.memo);
      setStaffType(draft.staffType || "designated");
      setTargetStaffId(draft.targetStaffId || null);

      if (newMenus.length > 0) {
        const dur = newMenus.reduce((s, m) => s + m.duration, 0);
        setEndTime(calcEndTime(draft.startTime, dur));
      } else {
        setEndTime(draft.endTime);
      }
      clearDraft("edit");
      setLoading(false);
      return;
    }

    if (!id) {
      setLoading(false);
      return;
    }

    reservations.get(id).then((data) => {
      const r = data.reservation;
      setCustomerName(r.customer_name || "");

      const start = toJSTDateAndTime(r.start_at);
      const end = toJSTDateAndTime(r.end_at);
      setDate(start.date);
      setStartTime(start.time);
      setEndTime(end.time);
      setMemo(r.memo || "");

      if (r.staff_id) {
        setStaffType("designated");
        setTargetStaffId(r.staff_id);
      } else {
        setStaffType("free");
        setTargetStaffId(null);
      }

      if (r.is_new_customer != null) {
        setIsNewCustomer(r.is_new_customer);
      } else {
        setIsNewCustomer(r.customer_visit_count === 0 ? 1 : 0);
      }

      if (r.menus && r.menus.length > 0) {
        setSelectedMenus(r.menus.map((m: { id: string; name: string; duration: number; price: number }) => ({
          id: m.id, name: m.name, duration: m.duration, price: m.price,
        })));
      }
    }).catch((error) => {
      console.error("Failed to fetch reservation:", error);
    }).finally(() => {
      setLoading(false);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- NEW MODE: Initialize from search params + sessionStorage ---
  useEffect(() => {
    if (isEdit) return;

    const paramDate = searchParams.get("date");
    const paramTime = searchParams.get("time");
    const paramStaffId = searchParams.get("staff_id");
    const paramCustomerId = searchParams.get("customer_id");
    const paramCustomerName = searchParams.get("customer_name");
    const paramMenuData = searchParams.get("menu_data");
    const paramSource = searchParams.get("source");

    if (paramStaffId) {
      setTargetStaffId(paramStaffId);
    } else if (staff?.id) {
      setTargetStaffId(staff.id);
    }
    if (paramSource) {
      setSalonboardRoute(paramSource);
    }

    const draft = loadDraft("new");
    const isReturningFromSelection =
      (paramCustomerId && paramCustomerName) || paramMenuData;

    if (isReturningFromSelection) {
      if (paramCustomerId && paramCustomerName) {
        setCustomerId(paramCustomerId);
        setCustomerName(decodeURIComponent(paramCustomerName));
      }
      let newMenus: SelectedMenu[] = [];
      if (paramMenuData) {
        try {
          newMenus = JSON.parse(decodeURIComponent(paramMenuData));
          setSelectedMenus(newMenus);
        } catch { /* ignore */ }
      }

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
        if (!paramStaffId) {
          setStaffType(draft.staffType || "designated");
          setTargetStaffId(draft.targetStaffId || null);
        }

        if (paramMenuData && newMenus.length > 0) {
          const dur = newMenus.reduce((s, m) => s + m.duration, 0);
          setEndTime(calcEndTime(draft.startTime, dur));
        } else {
          setEndTime(draft.endTime);
        }
        clearDraft("new");
      } else {
        // No draft — restore date/time from URL params
        if (paramDate) setDate(paramDate);
        const effectiveStart = paramTime || startTime;
        if (paramTime) setStartTime(paramTime);
        if (newMenus.length > 0) {
          const dur = newMenus.reduce((s, m) => s + m.duration, 0);
          if (dur > 0) {
            setEndTime(calcEndTime(effectiveStart, dur));
          }
        } else if (paramTime) {
          const [h, m] = paramTime.split(":").map(Number);
          setEndTime(`${(h + 1).toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`);
        }
      }
      return;
    }

    if (paramDate) setDate(paramDate);
    if (paramTime) {
      setStartTime(paramTime);
      const [h, m] = paramTime.split(":").map(Number);
      setEndTime(`${(h + 1).toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const buildDraft = (): DraftData => ({
    customerId,
    reservationId,
    customerName,
    selectedMenus,
    date,
    startTime,
    endTime,
    memo,
    staffType,
    targetStaffId,
  });

  // Navigate to customer selection (new mode only)
  const handleSelectCustomer = () => {
    saveDraft(mode, buildDraft());
    router.push("/customers?mode=select");
  };

  // Navigate to menu selection
  const handleSelectMenu = () => {
    saveDraft(mode, buildDraft());
    const effectiveStaffId = staffType === "designated" && targetStaffId ? targetStaffId : staff?.id;
    const selectedParam = selectedMenus.length > 0
      ? `&selected=${encodeURIComponent(JSON.stringify(selectedMenus))}`
      : "";
    const dtParams = `&return_date=${encodeURIComponent(date)}&return_time=${encodeURIComponent(startTime)}`;
    if (isEdit) {
      router.push(`/menus?mode=select&return=edit&reservation_id=${reservationId}${effectiveStaffId ? `&staff_id=${effectiveStaffId}` : ""}${selectedParam}`);
    } else {
      router.push(`/menus?mode=select${effectiveStaffId ? `&staff_id=${effectiveStaffId}` : ""}${selectedParam}${dtParams}`);
    }
  };

  // --- NEW MODE: Create reservation ---
  const handleCreate = async (force?: boolean) => {
    if (!currentStore || !staff || !customerId || selectedMenus.length === 0 || !endTime) return;

    setSubmitting(true);
    try {
      const startAt = new Date(`${date}T${startTime}:00+09:00`);
      const endAt = new Date(`${date}T${endTime}:00+09:00`);
      const effectiveStaffId = staffType === "designated" && targetStaffId
        ? targetStaffId
        : staff!.id;
      const routeSourceMap: Record<string, "phone" | "walk-in" | "web" | "line" | "minimo"> = {
        "phone": "phone", "phone-hpb": "phone", "walk-in": "walk-in", "web": "web",
        "minimo": "minimo", "nailie": "phone", "line": "line", "next-visit": "phone",
        "practice-model": "phone", "instagram": "phone", "friend": "phone", "fix": "phone",
      };
      const result = await reservations.create({
        store_id: currentStore!.id,
        customer_id: customerId,
        staff_id: effectiveStaffId,
        menu_ids: selectedMenus.map(m => m.id),
        menu_data: selectedMenus.map(m => ({ id: m.id, name: m.name, duration: m.duration, price: m.price })),
        start_at: startAt.toISOString(),
        end_at: endAt.toISOString(),
        memo: memo || null,
        source: routeSourceMap[salonboardRoute] || "phone",
        is_nominated: staffType === "designated" ? 1 : 0,
        salonboard_route: salonboardRoute || undefined,
        is_new_customer: customerType === "new" ? 1 : customerType === "repeat" ? 0 : undefined,
        ...(force ? { force: true } : {}),
      });
      clearDraft("new");
      const newId = result?.reservation?.id;
      router.push(`/reservations?date=${date}${newId ? `&highlight=${newId}` : ""}`);
    } catch (error) {
      console.error("Failed to create reservation:", error);
      const message = error instanceof Error ? error.message : "予約の作成に失敗しました";
      if (!force && (message.includes("ブロック") || message.includes("not available") || message.includes("overlap") || message.includes("concurrent"))) {
        if (confirm("この時間が他の予約と重なりますが、予約を作成しますか？")) {
          setSubmitting(false);
          handleCreate(true);
          return;
        }
      } else {
        alert(message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  // --- EDIT MODE: Save reservation ---
  const handleSave = async () => {
    if (!reservationId || !endTime) return;

    setSubmitting(true);
    try {
      const startAt = new Date(`${date}T${startTime}:00+09:00`);
      const endAt = new Date(`${date}T${endTime}:00+09:00`);
      const effectiveStaffId = targetStaffId || staff?.id || undefined;

      await reservations.update(reservationId, {
        staff_id: effectiveStaffId,
        menu_ids: selectedMenus.map(m => m.id),
        menu_data: selectedMenus.map(m => ({ id: m.id, name: m.name, duration: m.duration, price: m.price })),
        start_at: startAt.toISOString(),
        end_at: endAt.toISOString(),
        memo: memo || null,
        is_new_customer: isNewCustomer,
        is_nominated: staffType === "designated" ? 1 : 0,
      });

      clearDraft("edit");
      router.push(`/reservations/${reservationId}`);
    } catch (error) {
      console.error("Failed to update reservation:", error);
      alert(error instanceof Error ? error.message : "予約の更新に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <p className="text-muted-foreground">読み込み中...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 overflow-x-hidden">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => router.push(backPath)}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl font-bold">{isEdit ? "予約を編集" : "新規予約"}</h1>
      </div>

      {/* Customer */}
      <div className="space-y-2">
        <Label>顧客</Label>
        {isEdit ? (
          <div className="flex items-center gap-2 rounded-md border p-3 bg-muted/30">
            <User className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{customerName || "未設定"}</span>
          </div>
        ) : customerId ? (
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
          if (!isEdit && val === "free") {
            setSelectedMenus([]);
          }
        }}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="free">フリー</TabsTrigger>
            <TabsTrigger value="designated">指名</TabsTrigger>
          </TabsList>
        </Tabs>
        <Select
          value={targetStaffId || ""}
          onValueChange={(v) => {
            setTargetStaffId(v);
            if (!isEdit) setSelectedMenus([]);
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="スタッフを選択" />
          </SelectTrigger>
          <SelectContent>
            {staffList.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.nickname || s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
            } else if (timeToMin(endTime) <= timeToMin(t)) {
              // Ensure end time is after start time (default +1h)
              setEndTime(minToTime(timeToMin(t) + 60));
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

      {/* Customer Type / New-Repeat */}
      {isEdit ? (
        <div className="space-y-2">
          <Label>顧客区分</Label>
          <Tabs value={isNewCustomer === 1 ? "new" : "repeat"} onValueChange={(v) => setIsNewCustomer(v === "new" ? 1 : 0)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="new">新規</TabsTrigger>
              <TabsTrigger value="repeat">リピーター</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      ) : (
        <div className="space-y-2">
          <Label>新規 / リピーター</Label>
          <Tabs value={customerType} onValueChange={(v) => setCustomerType(v as "auto" | "new" | "repeat")}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="auto">自動判定</TabsTrigger>
              <TabsTrigger value="new">新規</TabsTrigger>
              <TabsTrigger value="repeat">リピーター</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      )}

      {/* Salonboard Route (new mode only) */}
      {!isEdit && (
        <div className="space-y-2">
          <Label>予約経路</Label>
          <Select value={salonboardRoute} onValueChange={setSalonboardRoute}>
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
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Memo */}
      <div className="space-y-2">
        <Label>メモ</Label>
        <Textarea
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="メモがあれば入力してください"
          rows={4}
        />
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-3 pt-2">
        {isEdit ? (
          <>
            <Button className="w-full" onClick={handleSave} disabled={submitting || !endTime}>
              {submitting ? "保存中..." : "変更を保存"}
            </Button>
            <Button className="w-full" variant="ghost" onClick={() => router.push(backPath)}>
              キャンセル
            </Button>
          </>
        ) : (
          <>
            <Button className="w-full" onClick={() => handleCreate()} disabled={submitting || !customerId || selectedMenus.length === 0 || !endTime}>
              {submitting ? "作成中..." : "予約を作成"}
            </Button>
            <Button
              className="w-full"
              variant="outline"
              onClick={() => router.push("/reservations?openBlock=true")}
            >
              <Ban className="mr-1 h-4 w-4" />
              個人の予定を設定する
            </Button>
            <Button className="w-full" variant="ghost" onClick={() => router.push("/reservations")}>
              戻る
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export default function ReservationForm({ mode }: ReservationFormProps) {
  return (
    <Suspense fallback={<div className="py-12 text-center text-muted-foreground">読み込み中...</div>}>
      <ReservationFormContent mode={mode} />
    </Suspense>
  );
}
