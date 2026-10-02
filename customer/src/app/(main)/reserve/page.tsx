"use client";

import { useEffect, useState, useMemo, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  API_BASE_URL,
  authApi,
  menusApi,
  staffApi,
  storeApi,
  reservationsApi,
  tokenStorage,
  setStoreId,
  getStoreId,
  type Customer,
  type Menu,
  type Staff,
  type TimeSlot,
} from "@/lib/api";
import { initLiff, isInLiffBrowser, getLiffAccessToken } from "@/lib/liff";
import { formatPrice, formatDuration } from "@/lib/utils";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Check,
  ChevronDown,
  User,
  Users,
  Phone,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";

const TIME_SLOTS = [
  "07:00", "07:30", "08:00", "08:30", "09:00", "09:30",
  "10:00", "10:30", "11:00", "11:30", "12:00", "12:30",
  "13:00", "13:30", "14:00", "14:30", "15:00", "15:30",
  "16:00", "16:30", "17:00", "17:30", "18:00", "18:30",
  "19:00", "19:30", "20:00", "20:30", "21:00", "21:30",
  "22:00", "22:30", "23:00", "23:30",
];

const DAYS_OF_WEEK = ["月", "火", "水", "木", "金", "土", "日"];

// Format date as YYYY-MM-DD in local timezone (avoids toISOString() UTC conversion bug in JST)
const formatLocalDate = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// Step labels for the progress indicator
const STEP_LABELS: Record<number, string> = {
  1: "スタッフ選択",
  2: "メニュー選択",
  3: "日時選択",
  4: "予約内容確認",
  5: "担当者について",
  6: "電話番号",
  7: "注意事項",
};

export default function ReservePage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    }>
      <ReservePageInner />
    </Suspense>
  );
}

function ReservePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const staffIdParam = searchParams.get("staff_id");
  const storeIdParam = searchParams.get("store_id");

  // Override store ID if provided via URL (e.g., from LINE)
  // Must be synchronous (not in useEffect) so it's set before data fetch effects run
  if (storeIdParam) {
    setStoreId(storeIdParam);
  }

  // Step management
  const [step, setStep] = useState(1);

  // Data
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [categoryColors, setCategoryColors] = useState<Record<string, string>>({});
  const [customerData, setCustomerData] = useState<Customer | null>(null);

  // Selections
  const [selectedStaff, setSelectedStaff] = useState<Staff | null>(null);
  const [isShimeiNashi, setIsShimeiNashi] = useState(false);
  const [selectedMenus, setSelectedMenus] = useState<Menu[]>([]);
  const [selectedDateTime, setSelectedDateTime] = useState<{ date: Date; time: string } | null>(null);
  const [note, setNote] = useState("");

  // Computed values for multi-menu
  const totalDuration = selectedMenus.reduce((s, m) => s + m.duration, 0);
  const totalPrice = selectedMenus.reduce((s, m) => s + m.price, 0);
  const [isFirstVisit, setIsFirstVisit] = useState<boolean | null>(null);
  const [phone, setPhone] = useState("");
  const [lastName, setLastName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastNameKana, setLastNameKana] = useState("");
  const [firstNameKana, setFirstNameKana] = useState("");
  const [policyAgreed, setPolicyAgreed] = useState(false);
  const [termsAgreed, setTermsAgreed] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Calendar state
  const [weeklySlots, setWeeklySlots] = useState<Map<string, TimeSlot[]>>(new Map());
  const [weekStart, setWeekStart] = useState(() => {
    const today = new Date();
    const day = today.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const monday = new Date(today);
    monday.setDate(today.getDate() + diff);
    monday.setHours(0, 0, 0, 0);
    return monday;
  });
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Loading states
  const [loading, setLoading] = useState(true);
  const [menusLoading, setMenusLoading] = useState(false);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [maxBookingDate, setMaxBookingDate] = useState<string | null>(null);
  const [closedDates, setClosedDates] = useState<Set<string>>(new Set());
  const [holidayDates, setHolidayDates] = useState<Set<string>>(new Set());
  const [businessHours, setBusinessHours] = useState<Map<string, { open: string; close: string }>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [liffAccessToken, setLiffAccessToken] = useState<string | null>(null);
  const timeGridRef = useRef<HTMLDivElement>(null);
  const hasScrolledToOpen = useRef(false);

  // Total steps (5 is skipped if 指名なし)
  const totalSteps = isShimeiNashi ? 6 : 7;

  // Calculate display step number (adjusting for skipped step 5)
  const getDisplayStep = (s: number) => {
    if (isShimeiNashi && s >= 5) return s - 1;
    return s;
  };

  // Week dates for calendar
  const weekDates = useMemo(() => {
    const dates: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + i);
      dates.push(date);
    }
    return dates;
  }, [weekStart]);

  const weekRangeText = useMemo(() => {
    const start = weekDates[0];
    const end = weekDates[6];
    return `${start.getMonth() + 1}月${start.getDate()}日〜${end.getMonth() + 1}月${end.getDate()}日`;
  }, [weekDates]);

  // Initial load: fetch staff list and customer data
  useEffect(() => {
    const fetchData = async () => {
      try {
        // Attempt to capture LIFF access token (for LINE user identification in guest reservation)
        if (storeIdParam) {
          try {
            const storeData = await storeApi.get();
            const storeLiffId = storeData.store?.line_liff_id;
            if (storeLiffId) {
              const initialized = await initLiff(storeLiffId);
              if (initialized && isInLiffBrowser()) {
                const token = getLiffAccessToken();
                if (token) {
                  setLiffAccessToken(token);
                  sessionStorage.setItem("liff_access_token", token);
                  // Authenticate via LIFF to get JWT (enables pre-filling name/phone for returning users)
                  try {
                    const res = await fetch(`${API_BASE_URL}/api/customer/auth/liff`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        liff_access_token: token,
                        store_id: getStoreId(),
                      }),
                    });
                    if (res.ok) {
                      const data = await res.json();
                      if (data.token) {
                        tokenStorage.set(data.token);
                      }
                    }
                  } catch (err) {
                    console.error("[Reserve] LIFF auth failed:", err);
                  }
                }
              }
            }
          } catch (err) {
            console.error("[Reserve] LIFF init failed:", err);
          }
        }

        const staffData = await staffApi.list();
        setStaffList(staffData.staff);

        // authApi.me() は失敗しても予約フロー自体は続行
        try {
          const authData = await authApi.me();
          setCustomerData(authData.customer);
          if (authData.customer.phone) setPhone(authData.customer.phone);
          // 保存済みの氏名/ふりがなを姓・名に分割して自動入力（空白は半角/全角どちらも対応）
          if (authData.customer.name) {
            const [sei, ...rest] = authData.customer.name.trim().split(/[\s　]+/);
            setLastName(sei);
            setFirstName(rest.join(" "));
          }
          if (authData.customer.name_kana) {
            const [seiKana, ...restKana] = authData.customer.name_kana.trim().split(/[\s　]+/);
            setLastNameKana(seiKana);
            setFirstNameKana(restKana.join(" "));
          }
        } catch {
          // 未ログイン — customerData は null のまま
        }

        // If staff_id query param is present, auto-select that staff and skip to step 2
        if (staffIdParam) {
          const matchedStaff = staffData.staff.find((s: Staff) => s.id === staffIdParam);
          if (matchedStaff) {
            setSelectedStaff(matchedStaff);
            setIsShimeiNashi(false);
            setStep(2);
          }
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  // Fetch menus when staff selection changes (step 2)
  useEffect(() => {
    if (step !== 2) return;
    setMenusLoading(true);
    const staffId = isShimeiNashi ? undefined : selectedStaff?.id;
    menusApi
      .list(staffId)
      .then((data) => {
        setMenus(data.menus);
        setCategoryColors(data.categoryColors || {});
      })
      .catch(console.error)
      .finally(() => setMenusLoading(false));
  }, [step, selectedStaff?.id, isShimeiNashi]);

  // Fetch available slots when on step 3
  useEffect(() => {
    if (selectedMenus.length === 0 || step !== 3) return;

    setSlotsLoading(true);
    const fetchPromises = weekDates.map(async (date) => {
      const dateStr = formatLocalDate(date);
      try {
        const data = await reservationsApi.getAvailableSlots({
          date: dateStr,
          menu_id: selectedMenus[0].id,
          staff_id: isShimeiNashi ? undefined : selectedStaff?.id,
          duration: totalDuration,
        });
        return { dateStr, slots: data.slots, max_booking_date: data.max_booking_date, closed: data.closed || data.blocked, open_time: data.open_time, close_time: data.close_time, is_holiday: data.is_holiday };
      } catch {
        return { dateStr, slots: [] };
      }
    });

    Promise.all(fetchPromises)
      .then((results) => {
        const newMap = new Map<string, TimeSlot[]>();
        const newClosedDates = new Set<string>();
        const newHolidayDates = new Set<string>();
        const newBusinessHours = new Map<string, { open: string; close: string }>();
        results.forEach(({ dateStr, slots, max_booking_date, closed, open_time, close_time, is_holiday }) => {
          newMap.set(dateStr, slots);
          if (closed) newClosedDates.add(dateStr);
          if (is_holiday) newHolidayDates.add(dateStr);
          if (open_time && close_time) newBusinessHours.set(dateStr, { open: open_time, close: close_time });
          if (max_booking_date) setMaxBookingDate(max_booking_date);
        });
        setClosedDates(newClosedDates);
        setHolidayDates(newHolidayDates);
        setBusinessHours(newBusinessHours);
        setWeeklySlots(newMap);
      })
      .finally(() => setSlotsLoading(false));
  }, [selectedMenus, totalDuration, selectedStaff, weekDates, step, isShimeiNashi]);

  // Auto-scroll to earliest opening time when slots load
  useEffect(() => {
    if (slotsLoading || businessHours.size === 0 || !timeGridRef.current) return;
    if (hasScrolledToOpen.current) return;
    hasScrolledToOpen.current = true;

    let earliestOpen = "23:30";
    businessHours.forEach(({ open }) => {
      if (open < earliestOpen) earliestOpen = open;
    });

    const slotIndex = TIME_SLOTS.indexOf(earliestOpen);
    if (slotIndex > 0) {
      // Each row is ~40px (min-h-[40px]), scroll to 1 slot before opening
      const scrollTo = Math.max(0, (slotIndex - 1)) * 40;
      timeGridRef.current.scrollTop = scrollTo;
    }
  }, [slotsLoading, businessHours]);

  const navigateWeek = (direction: "prev" | "next") => {
    const newStart = new Date(weekStart);
    newStart.setDate(weekStart.getDate() + (direction === "next" ? 7 : -7));

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const minStart = new Date(today);
    const day = minStart.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    minStart.setDate(today.getDate() + diff);

    if (newStart < minStart) return;

    // Limit forward navigation by max booking date
    if (direction === "next" && maxBookingDate) {
      const maxDate = new Date(maxBookingDate + "T00:00:00");
      if (newStart > maxDate) return;
    }

    setWeekStart(newStart);
    setSelectedDateTime(null);
    hasScrolledToOpen.current = false;
  };

  const isDateClosed = (date: Date): boolean => {
    return closedDates.has(formatLocalDate(date));
  };

  const isOutsideBusinessHours = (date: Date, time: string): boolean => {
    const dateStr = formatLocalDate(date);
    const hours = businessHours.get(dateStr);
    if (!hours) return false;
    return time < hours.open || time >= hours.close;
  };

  const isSlotAvailable = (date: Date, time: string): boolean | "consultation" | "other_staff" | "closed" => {
    const dateStr = formatLocalDate(date);
    if (closedDates.has(dateStr)) return "closed";
    const slots = weeklySlots.get(dateStr);
    if (!slots) return false;

    const slot = slots.find((s) => s.time === time);
    if (!slot) {
      // Outside business hours → unavailable (not consultation)
      if (isOutsideBusinessHours(date, time)) return false;
      return "consultation";
    }
    if (slot.available) return true;
    if (slot.available_other_staff) return "other_staff";
    return false;
  };

  const isDatePast = (date: Date) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date < today;
  };

  const handleSlotClick = (date: Date, time: string) => {
    const available = isSlotAvailable(date, time);
    if (available === true && !isDatePast(date)) {
      setSelectedDateTime({ date, time });
      setSubmitError(null);
    }
  };

  // Navigate to next step (handling skip of step 5 for 指名なし)
  const goToNextStep = () => {
    if (step === 4 && isShimeiNashi) {
      setStep(6); // Skip step 5
    } else {
      setStep(step + 1);
    }
  };

  const goToPrevStep = () => {
    if (step === 6 && isShimeiNashi) {
      setStep(4); // Skip step 5 going back
    } else {
      setStep(step - 1);
    }
  };

  const handleSubmit = async () => {
    if (selectedMenus.length === 0 || !selectedDateTime) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      // 送信前に最新の空き状況を再チェック
      const dateStr = formatLocalDate(selectedDateTime.date);
      const freshSlots = await reservationsApi.getAvailableSlots({
        date: dateStr,
        menu_id: selectedMenus[0].id,
        staff_id: isShimeiNashi ? undefined : selectedStaff?.id,
        duration: totalDuration,
      });
      const targetSlot = freshSlots.slots.find((s) => s.time === selectedDateTime.time);
      if (!targetSlot || !targetSlot.available) {
        setSelectedDateTime(null);
        setPolicyAgreed(false);
        setStep(3);
        setSubmitError("この時間帯はすでに予約が入っています");
        setSubmitting(false);
        return;
      }

      // Build JST datetime explicitly to avoid timezone issues
      const [hours, minutes] = selectedDateTime.time.split(":").map(Number);
      const startTime = new Date(`${dateStr}T${String(hours).padStart(2,"0")}:${String(minutes).padStart(2,"0")}:00+09:00`);

      // 姓・名（ふりがな）を結合（名が空なら姓のみ。半角スペース区切り）
      const fullName = [lastName.trim(), firstName.trim()].filter(Boolean).join(" ");
      const fullNameKana = [lastNameKana.trim(), firstNameKana.trim()].filter(Boolean).join(" ");

      if (customerData) {
        // ログイン済み — 通常の予約作成
        await reservationsApi.create({
          store_id: getStoreId(),
          menu_id: selectedMenus[0].id,
          menu_ids: selectedMenus.map(m => m.id),
          staff_id: isShimeiNashi ? undefined : selectedStaff?.id,
          start_at: startTime.toISOString(),
          memo: note || undefined,
          phone: phone || undefined,
          name: fullName || undefined,
          name_kana: fullNameKana || undefined,
          is_first_visit: isFirstVisit ?? undefined,
        });
      } else {
        // 未ログイン — ゲスト予約
        await reservationsApi.createGuest({
          store_id: getStoreId(),
          menu_id: selectedMenus[0].id,
          menu_ids: selectedMenus.map(m => m.id),
          staff_id: isShimeiNashi ? undefined : selectedStaff?.id,
          start_at: startTime.toISOString(),
          memo: note || undefined,
          phone: phone,
          name: fullName,
          name_kana: fullNameKana || undefined,
          is_first_visit: isFirstVisit ?? undefined,
          liff_access_token: liffAccessToken || undefined,
        });
      }

      if (customerData) {
        router.push("/mypage/reservations?success=1");
      } else {
        setCompleted(true);
      }
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : "予約に失敗しました";
      // 時間帯の競合エラーの場合、カレンダーに戻してスロットを再取得
      if (
        message.includes("すでに予約が入っています") ||
        message.includes("対応可能なスタッフがいません") ||
        message.includes("ブロックが設定されています")
      ) {
        setSelectedDateTime(null);
        setPolicyAgreed(false);
        setStep(3); // カレンダーに戻す（useEffectでスロット再取得される）
        setSubmitError(message);
      } else {
        setSubmitError(message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Handle staff selection
  const handleStaffSelect = (staff: Staff | null) => {
    if (staff === null) {
      setIsShimeiNashi(true);
      setSelectedStaff(null);
    } else {
      setIsShimeiNashi(false);
      setSelectedStaff(staff);
    }
    // Reset downstream selections
    setSelectedMenus([]);
    setSelectedDateTime(null);
    setIsFirstVisit(null);
    setStep(2);
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (completed) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center text-center p-8 space-y-4">
            <div className="h-16 w-16 rounded-full bg-green-100 flex items-center justify-center">
              <Check className="h-8 w-8 text-green-600" />
            </div>
            <h2 className="text-xl font-bold">お申し込みが完了しました</h2>
            <p className="text-xs text-red-500 font-medium">※まだ予約は確定しておりません</p>
            <p className="text-sm text-muted-foreground text-left whitespace-pre-line">
              {`ご予約のお申し込みありがとうございます！

ただいまスタッフがスケジュールを確認しております。
このメッセージの時点では、予約はまだ「仮受付」の状態です。

確認ができ次第、すぐにこちらのトーク（メール）からお返事いたします。
確定の連絡まで、いましばらくお待ちくださいませ。`}
            </p>
            <Button
              className="w-full"
              onClick={() => router.push("/mypage/reservations")}
            >
              予約確認
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Progress Indicator */}
      <div className="border-b bg-background px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-foreground">
            {STEP_LABELS[step]}
          </span>
          <span className="text-xs text-muted-foreground">
            {getDisplayStep(step)} / {totalSteps}
          </span>
        </div>
        <div className="w-full bg-muted rounded-full h-1.5">
          <div
            className="bg-primary h-1.5 rounded-full transition-all duration-300"
            style={{ width: `${(getDisplayStep(step) / totalSteps) * 100}%` }}
          />
        </div>
      </div>

      {/* Step 1: スタッフ選択 */}
      {step === 1 && (
        <div className="p-4 space-y-4">
          <h1 className="text-xl font-bold">担当スタッフを選択</h1>
          <p className="text-sm text-muted-foreground">
            施術を担当するスタッフを選んでください
          </p>

          <div className="grid grid-cols-2 gap-3">
            {/* 指名なし */}
            <Card
              className="cursor-pointer transition-all hover:border-primary/50"
              onClick={() => handleStaffSelect(null)}
            >
              <CardContent className="flex flex-col items-center justify-center p-4 text-center">
                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-2">
                  <Users className="h-8 w-8 text-muted-foreground" />
                </div>
                <span className="font-medium text-sm">指名なし</span>
                <span className="text-xs text-muted-foreground mt-0.5">
                  スタッフおまかせ
                </span>
              </CardContent>
            </Card>

            {/* Staff list */}
            {staffList.map((staff) => (
              <Card
                key={staff.id}
                className="cursor-pointer transition-all hover:border-primary/50"
                onClick={() => handleStaffSelect(staff)}
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
        </div>
      )}

      {/* Step 2: メニュー選択 */}
      {step === 2 && (
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setStep(1)}>
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-xl font-bold">メニューを選択</h1>
              <p className="text-sm text-muted-foreground">
                担当: {isShimeiNashi ? "指名なし" : selectedStaff?.name}
              </p>
            </div>
          </div>

          {menusLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            </div>
          ) : (
            <>
              <div className="space-y-3 pb-24">
                {menus.map((menu) => {
                  const isSelected = selectedMenus.some(m => m.id === menu.id);
                  return (
                    <Card
                      key={menu.id}
                      className={cn(
                        "cursor-pointer transition-all relative overflow-hidden",
                        isSelected
                          ? "border-primary ring-2 ring-primary/20"
                          : "hover:border-primary/50"
                      )}
                      onClick={() => {
                        setSelectedMenus(prev =>
                          prev.some(m => m.id === menu.id)
                            ? prev.filter(m => m.id !== menu.id)
                            : [...prev, menu]
                        );
                      }}
                    >
                      {menu.coupon_type && (
                        <div className="absolute top-0 left-0 bg-red-500 text-white px-2 py-0.5 text-[10px] font-bold rounded-br-lg z-10">
                          クーポン
                        </div>
                      )}
                      <CardContent className="flex gap-2.5 p-3">
                        {menu.image_url && (
                          <img
                            src={`${API_BASE_URL}${menu.image_url}`}
                            alt={menu.name}
                            className="h-20 w-20 rounded-md object-cover flex-shrink-0"
                          />
                        )}
                        <div className="flex-1 min-w-0 flex flex-col">
                          <div className="flex items-start gap-1.5 flex-wrap">
                            <h3 className="font-semibold text-sm leading-snug">{menu.name}</h3>
                          </div>
                          {menu.coupon_type && (
                            <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                              <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold text-white ${
                                menu.coupon_type === 'new' ? 'bg-blue-500' :
                                menu.coupon_type === 'repeat' ? 'bg-green-500' :
                                'bg-orange-500'
                              }`}>
                                {menu.coupon_type === 'new' ? '新規のみ' : menu.coupon_type === 'repeat' ? '来店顧客のみ' : '誰でも可'}
                              </span>
                              {menu.category && (
                                <span
                                  className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold text-white"
                                  style={{ backgroundColor: categoryColors[menu.category] || '#6B7280' }}
                                >
                                  {menu.category.includes('：') ? menu.category.split('：')[0] : menu.category}
                                </span>
                              )}
                            </div>
                          )}
                          {menu.description && (
                            <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                              {menu.description}
                            </p>
                          )}
                          <div className="mt-auto flex items-center justify-between pt-1">
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Clock className="h-3 w-3" />
                              {formatDuration(menu.duration)}
                            </span>
                            <div className="flex items-center gap-1.5">
                              <span className="font-bold text-primary text-sm">
                                {formatPrice(menu.price)}{menu.price_tilde ? '～' : ''}
                              </span>
                              {isSelected && (
                                <Check className="h-5 w-5 text-primary" />
                              )}
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              {/* Fixed bottom bar - above bottom nav */}
              <div className="fixed bottom-[calc(4rem+env(safe-area-inset-bottom,0px))] left-0 right-0 border-t bg-background p-4 z-40">
                <Button
                  className="w-full"
                  size="lg"
                  disabled={selectedMenus.length === 0}
                  onClick={() => setStep(3)}
                >
                  {selectedMenus.length > 0
                    ? `決定 (${selectedMenus.length}件 / ${formatDuration(totalDuration)} / ${formatPrice(totalPrice)})`
                    : "メニューを選択してください"}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Step 3: 日時選択 */}
      {step === 3 && (
        <div className="flex flex-col h-[calc(100vh-120px)]">
          {submitError && (
            <div className="mx-4 mt-2 rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
              {submitError}。別の日時を選択してください。
              <button
                className="ml-2 underline"
                onClick={() => setSubmitError(null)}
              >
                閉じる
              </button>
            </div>
          )}
          <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
            <CollapsibleTrigger className="flex items-center justify-center gap-1 w-full py-2 text-sm text-muted-foreground hover:text-foreground">
              <ChevronDown className={cn("h-4 w-4 transition-transform", detailsOpen && "rotate-180")} />
              予約の詳細を見る
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="px-4 pb-3 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">メニュー</span>
                  <span className="text-right">
                    {selectedMenus.map(m => m.name).join('、')}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">担当者</span>
                  <span>{isShimeiNashi ? "指名なし" : selectedStaff?.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">所要時間</span>
                  <span>{formatDuration(totalDuration)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">料金</span>
                  <span className="font-bold text-primary">{formatPrice(totalPrice)}</span>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Week navigation */}
          <div className="flex items-center justify-between px-2 py-2 border-b bg-muted/30">
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={() => navigateWeek("prev")}
            >
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <div className="text-center">
              <div className="text-sm text-muted-foreground">{weekDates[0].getFullYear()}</div>
              <div className="font-bold">{weekRangeText}</div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={() => navigateWeek("next")}
            >
              <ChevronRight className="h-5 w-5" />
            </Button>
          </div>

          {/* Grid */}
          <div className="flex-1 overflow-auto" ref={timeGridRef}>
            {slotsLoading ? (
              <div className="flex items-center justify-center h-full">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              </div>
            ) : (
              <div className="min-w-[360px]">
                <div className="sticky top-0 z-10 bg-background border-b">
                  <div className="grid grid-cols-[50px_repeat(7,1fr)]">
                    <div className="p-2" />
                    {weekDates.map((date, i) => {
                      const isToday = date.toDateString() === new Date().toDateString();
                      const isSunday = date.getDay() === 0;
                      const isSaturday = date.getDay() === 6;
                      const isClosed = isDateClosed(date);
                      const isHoliday = holidayDates.has(formatLocalDate(date));
                      return (
                        <div
                          key={i}
                          className={cn(
                            "p-2 text-center border-l",
                            isClosed ? "bg-gray-100 text-gray-400" : [
                              isToday && "bg-primary/10",
                              (isSunday || isHoliday) && "text-red-500",
                              isSaturday && !isHoliday && "text-blue-500",
                            ]
                          )}
                        >
                          <div className="text-lg font-bold">{date.getDate()}</div>
                          <div className="text-xs flex items-center justify-center gap-0.5">
                            {DAYS_OF_WEEK[i]}
                            {isHoliday && <span className="text-[9px] text-red-500 font-bold">祝</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div>
                  {TIME_SLOTS.map((time) => (
                    <div key={time} className="grid grid-cols-[50px_repeat(7,1fr)] border-b">
                      <div className="p-2 text-xs text-muted-foreground text-right pr-3 flex items-center justify-end">
                        {time}
                      </div>
                      {weekDates.map((date, i) => {
                        const available = isSlotAvailable(date, time);
                        const isPast = isDatePast(date);
                        const isSelected =
                          selectedDateTime?.date.toDateString() === date.toDateString() &&
                          selectedDateTime?.time === time;
                        const isSunday = date.getDay() === 0;
                        const isSaturday = date.getDay() === 6;
                        const isClosed = available === "closed";
                        const isOutside = !isClosed && !isPast && isOutsideBusinessHours(date, time);

                        return (
                          <div
                            key={i}
                            className={cn(
                              "p-1 border-l flex items-center justify-center min-h-[40px]",
                              isClosed || isOutside ? "bg-gray-100" : [
                                isSunday && "bg-red-50",
                                isSaturday && "bg-blue-50",
                              ]
                            )}
                          >
                            {isClosed || isOutside ? (
                              <span className="text-xs text-gray-300">-</span>
                            ) : isPast ? (
                              <span className="text-xs text-muted-foreground">-</span>
                            ) : available === true ? (
                              <button
                                onClick={() => handleSlotClick(date, time)}
                                className={cn(
                                  "w-8 h-8 rounded-full border-2 transition-all flex items-center justify-center",
                                  isSelected
                                    ? "bg-red-500 border-red-500"
                                    : "border-primary text-primary hover:bg-primary/10"
                                )}
                              >
                                {isSelected ? (
                                  <span className="w-3 h-3 bg-white rounded-full" />
                                ) : (
                                  <span className="w-4 h-4 rounded-full border-2 border-current" />
                                )}
                              </button>
                            ) : (available === "other_staff" || available === "consultation") ? (
                              <button
                                className="text-[10px] text-primary font-medium underline"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const storeId = getStoreId();
                                  const staffId = selectedStaff?.id;
                                  const params = new URLSearchParams();
                                  if (storeId) params.set("store_id", storeId);
                                  if (staffId) params.set("staff_id", staffId);
                                  router.push(`/messages?${params.toString()}`);
                                }}
                              >
                                相談可
                              </button>
                            ) : (
                              <span className="w-3 h-3 bg-muted rounded-full" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Bottom bar */}
          <div className="sticky bottom-0 border-t bg-background p-4 space-y-3">
            {selectedDateTime && (
              <div className="text-center font-bold">
                {selectedDateTime.date.getMonth() + 1}月{selectedDateTime.date.getDate()}日
                （{DAYS_OF_WEEK[(selectedDateTime.date.getDay() + 6) % 7]}）
                {selectedDateTime.time}〜
                {(() => {
                  if (selectedMenus.length === 0) return "";
                  const [h, m] = selectedDateTime.time.split(":").map(Number);
                  const endMinutes = h * 60 + m + totalDuration;
                  const endH = Math.floor(endMinutes / 60);
                  const endM = endMinutes % 60;
                  return `${endH}:${endM.toString().padStart(2, "0")}`;
                })()}
              </div>
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep(2)} className="flex-1">
                <ChevronLeft className="mr-1 h-4 w-4" />
                戻る
              </Button>
              <Button
                className="flex-1"
                disabled={!selectedDateTime}
                onClick={() => setStep(4)}
              >
                次へ
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Step 4: 予約内容確認 */}
      {step === 4 && (
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setStep(3)}>
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <h1 className="text-xl font-bold">予約内容の確認</h1>
          </div>

          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="space-y-3">
                <div>
                  <span className="text-muted-foreground text-sm">メニュー</span>
                  {selectedMenus.map((m, i) => (
                    <div key={m.id} className={cn("flex justify-between py-1", i > 0 && "border-t border-dashed")}>
                      <span className="font-medium">{m.name}</span>
                      <span className="text-sm text-muted-foreground">
                        {formatDuration(m.duration)} / {formatPrice(m.price)}{m.price_tilde ? '～' : ''}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">担当者</span>
                  <span className="font-medium">
                    {isShimeiNashi ? "指名なし" : selectedStaff?.name}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">日時</span>
                  <span className="font-medium">
                    {selectedDateTime &&
                      `${selectedDateTime.date.getMonth() + 1}月${selectedDateTime.date.getDate()}日（${DAYS_OF_WEEK[(selectedDateTime.date.getDay() + 6) % 7]}）${selectedDateTime.time}`}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">所要時間</span>
                  <span className="font-medium">
                    {formatDuration(totalDuration)}
                  </span>
                </div>
                <div className="flex justify-between border-t pt-3">
                  <span className="font-medium">料金</span>
                  <span className="text-lg font-bold text-primary">
                    {formatPrice(totalPrice)}{selectedMenus.some(m => m.price_tilde) ? '～' : ''}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="note">備考（任意）</Label>
                <Textarea
                  id="note"
                  placeholder="ご要望などがあればご記入ください"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </CardContent>
          </Card>

          <Button className="w-full" size="lg" onClick={goToNextStep}>
            次へ
            <ChevronRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Step 5: 担当者について（スタッフ指名時のみ） */}
      {step === 5 && !isShimeiNashi && (
        <div className="p-4 space-y-6">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setStep(4)}>
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <h1 className="text-xl font-bold">担当者について</h1>
          </div>

          <div className="text-center space-y-2 py-4">
            {selectedStaff?.avatar_url ? (
              <img
                src={`${API_BASE_URL}${selectedStaff.avatar_url}`}
                alt={selectedStaff.name}
                className="w-20 h-20 rounded-full object-cover mx-auto"
              />
            ) : (
              <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                <User className="h-10 w-10 text-primary" />
              </div>
            )}
            <p className="text-lg font-medium">{selectedStaff?.name}</p>
            <p className="text-muted-foreground">
              過去に担当してもらったことはありますか？
            </p>
          </div>

          <div className="space-y-3">
            <Card
              className={cn(
                "cursor-pointer transition-all",
                isFirstVisit === false
                  ? "border-primary ring-2 ring-primary/20"
                  : "hover:border-primary/50"
              )}
              onClick={() => setIsFirstVisit(false)}
            >
              <CardContent className="flex items-center gap-4 p-4">
                <div className={cn(
                  "w-10 h-10 rounded-full flex items-center justify-center",
                  isFirstVisit === false ? "bg-primary text-primary-foreground" : "bg-muted"
                )}>
                  <Check className="h-5 w-5" />
                </div>
                <div>
                  <p className="font-medium">はい（担当あり）</p>
                  <p className="text-sm text-muted-foreground">以前に施術してもらったことがあります</p>
                </div>
              </CardContent>
            </Card>

            <Card
              className={cn(
                "cursor-pointer transition-all",
                isFirstVisit === true
                  ? "border-primary ring-2 ring-primary/20"
                  : "hover:border-primary/50"
              )}
              onClick={() => setIsFirstVisit(true)}
            >
              <CardContent className="flex items-center gap-4 p-4">
                <div className={cn(
                  "w-10 h-10 rounded-full flex items-center justify-center",
                  isFirstVisit === true ? "bg-primary text-primary-foreground" : "bg-muted"
                )}>
                  <User className="h-5 w-5" />
                </div>
                <div>
                  <p className="font-medium">いいえ（初めて）</p>
                  <p className="text-sm text-muted-foreground">初めて施術してもらいます</p>
                </div>
              </CardContent>
            </Card>
          </div>

          <Button
            className="w-full"
            size="lg"
            disabled={isFirstVisit === null}
            onClick={() => setStep(6)}
          >
            次へ
            <ChevronRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Step 6: お客様情報入力 */}
      {step === 6 && (
        <div className="p-4 space-y-6">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={goToPrevStep}>
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <h1 className="text-xl font-bold">お客様情報</h1>
          </div>

          <div className="text-center py-4">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
              <Phone className="h-8 w-8 text-primary" />
            </div>
            <p className="text-muted-foreground text-sm">
              ご予約に必要な情報をご入力ください
            </p>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>
                お名前 <span className="text-destructive">*</span>
              </Label>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  id="lastName"
                  type="text"
                  placeholder="姓（山田）"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="text-lg"
                />
                <Input
                  id="firstName"
                  type="text"
                  placeholder="名（花子）"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="text-lg"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>
                ふりがな <span className="text-destructive">*</span>
              </Label>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  id="lastNameKana"
                  type="text"
                  placeholder="せい（やまだ）"
                  value={lastNameKana}
                  onChange={(e) => setLastNameKana(e.target.value)}
                  className="text-lg"
                />
                <Input
                  id="firstNameKana"
                  type="text"
                  placeholder="めい（はなこ）"
                  value={firstNameKana}
                  onChange={(e) => setFirstNameKana(e.target.value)}
                  className="text-lg"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone">
                電話番号 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="phone"
                type="tel"
                placeholder="090-1234-5678"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="text-lg"
              />
            </div>
          </div>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={termsAgreed}
              onChange={(e) => setTermsAgreed(e.target.checked)}
              className="mt-1 h-5 w-5 rounded border-gray-300 text-primary focus:ring-primary"
            />
            <span className="text-sm">
              <a href="/terms" target="_blank" rel="noopener noreferrer" className="text-primary underline">利用規約</a>
              ・
              <a href="/privacy" target="_blank" rel="noopener noreferrer" className="text-primary underline">プライバシーポリシー</a>
              に同意する
            </span>
          </label>

          <Button
            className="w-full"
            size="lg"
            disabled={!lastName.trim() || !firstName.trim() || !lastNameKana.trim() || !firstNameKana.trim() || !phone.trim() || !termsAgreed}
            onClick={() => setStep(7)}
          >
            次へ
            <ChevronRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Step 7: ご来店に関する注意事項 */}
      {step === 7 && (
        <div className="p-4 space-y-6">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setStep(6)}>
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <h1 className="text-xl font-bold">ご来店に関する注意事項</h1>
          </div>

          <div className="text-center py-2">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
              <ShieldCheck className="h-8 w-8 text-primary" />
            </div>
          </div>

          <Card>
            <CardContent className="pt-6 space-y-4 text-sm leading-relaxed">
              <div>
                <h3 className="font-bold mb-1">キャンセルポリシー</h3>
                <div className="text-muted-foreground space-y-1">
                  <p>無断キャンセル　全額</p>
                  <p>当日キャンセル　80%</p>
                  <p>当日別日変更　3,300円</p>
                  <p>当日時間変更（その日のうち来店）　1,100円</p>
                  <p>10分以上のお遅刻　1,100円</p>
                </div>
              </div>

              <div>
                <p className="text-muted-foreground">
                  営業時間外の施術は＋1,100円になります。5分以上遅れる場合施術工程が十分にできない場合がございます。15分以上ご連絡なくご来店されていない場合、無断キャンセルとなります。前日の営業時間を過ぎてからのキャンセル、変更は当日扱いとなります。
                </p>
              </div>

              <div>
                <h3 className="font-bold mb-1">メニュー変更について</h3>
                <p className="text-muted-foreground">
                  当日のメニュー変更、コースダウンは不可です。メニューの追加は後ろにお時間がある場合のみ追加可能となります。
                </p>
              </div>
            </CardContent>
          </Card>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={policyAgreed}
              onChange={(e) => setPolicyAgreed(e.target.checked)}
              className="mt-1 h-5 w-5 rounded border-gray-300 text-primary focus:ring-primary"
            />
            <span className="text-sm">
              上記の注意事項を確認しました
            </span>
          </label>

          {submitError && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
              {submitError}
            </div>
          )}

          <Button
            className="w-full"
            size="lg"
            disabled={!policyAgreed || submitting}
            onClick={handleSubmit}
          >
            {submitting ? "予約中..." : "予約を完了する"}
          </Button>
        </div>
      )}
    </div>
  );
}
