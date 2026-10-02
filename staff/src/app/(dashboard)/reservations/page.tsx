"use client";

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from "react";
import { format } from "date-fns";
import { useRouter, useSearchParams } from "next/navigation";
import { useSwipeNavigation } from "@/hooks/use-swipe-navigation";
import { Plus, ChevronLeft, ChevronRight, Clock, Ban, Trash2, Pencil } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { reservations, staffBlocks, staffSettings, staffApi, stores as storesApi, equipment as equipmentApi, menus as menusApi, type Reservation, type StaffBlock, type StaffBusinessHours, type Staff } from "@/lib/api";
import { formatDate, cn, getImageUrl } from "@/lib/utils";
import { isJapaneseHoliday } from "@/lib/japaneseHolidays";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useStore } from "@/contexts/store-context";
import { useReservationDrag, formatDragTime, isDraggableStatus, slotsToTime } from "@/hooks/use-reservation-drag";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
// Convert hex color to rgba for background with opacity
function hexToStyle(hex: string, status: Reservation["status"]) {
  const isCancelled = status === "cancelled" || status === "noshow";
  if (isCancelled) {
    return { backgroundColor: "#f3f4f6", borderColor: "#d1d5db", color: "#9ca3af" };
  }
  // Parse hex
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return {
    backgroundColor: `rgba(${r},${g},${b},0.15)`,
    borderColor: `rgba(${r},${g},${b},0.5)`,
  };
}

const DEFAULT_CATEGORY_COLOR = "#6B7280";

type ViewMode = "day" | "week" | "month";

function getToday(): string {
  const now = new Date();
  const jstDate = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  return format(jstDate, "yyyy-MM-dd");
}

// Extract JST date key from a UTC datetime string
function toJSTDateKey(dateStr: string): string {
  let normalized = dateStr;
  if (!dateStr.endsWith("Z") && !dateStr.includes("+")) {
    normalized = dateStr.replace(" ", "T") + "Z";
  }
  const d = new Date(normalized);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const year = jst.getUTCFullYear();
  const month = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jst.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateLocal(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function isSameDay(date: Date, dateStr: string): boolean {
  return formatDateLocal(date) === dateStr;
}

// Convert UTC date to JST hours/minutes
function toJST(dateStr: string) {
  // Normalize date strings without timezone suffix to UTC (e.g. "2026-02-28 03:00:00" → add Z)
  let normalized = dateStr;
  if (!dateStr.endsWith('Z') && !dateStr.includes('+')) {
    normalized = dateStr.replace(' ', 'T') + 'Z';
  }
  const d = new Date(normalized);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return { hour: jst.getUTCHours(), minute: jst.getUTCMinutes() };
}

// Calculate side-by-side layout for overlapping reservations
function layoutOverlapping(items: { id: string; top: number; bottom: number }[]) {
  if (items.length === 0) return new Map<string, { col: number; total: number }>();
  const sorted = [...items].sort((a, b) => a.top - b.top || (b.bottom - b.top) - (a.bottom - a.top));

  // Greedy column assignment
  const colEnds: number[] = [];
  const colAssign = new Map<string, number>();
  for (const item of sorted) {
    let placed = -1;
    for (let c = 0; c < colEnds.length; c++) {
      if (item.top >= colEnds[c]) {
        placed = c;
        colEnds[c] = item.bottom;
        break;
      }
    }
    if (placed === -1) {
      placed = colEnds.length;
      colEnds.push(item.bottom);
    }
    colAssign.set(item.id, placed);
  }

  // Union-Find for connected components of overlapping items
  const par = new Map<string, string>();
  for (const item of sorted) par.set(item.id, item.id);
  const find = (x: string): string => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x)!)!); x = par.get(x)!; } return x; };
  const unite = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) par.set(ra, rb); };
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].top < sorted[i].bottom) unite(sorted[i].id, sorted[j].id);
    }
  }

  // Each connected component gets the same totalColumns
  const groupMax = new Map<string, number>();
  for (const item of sorted) {
    const root = find(item.id);
    groupMax.set(root, Math.max(groupMax.get(root) || 0, colAssign.get(item.id)!));
  }
  const result = new Map<string, { col: number; total: number }>();
  for (const item of sorted) {
    result.set(item.id, { col: colAssign.get(item.id)!, total: groupMax.get(find(item.id))! + 1 });
  }
  return result;
}

function ReservationsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { currentStore, staff } = useStore();
  const [selectedDate, setSelectedDate] = useState<string>(searchParams.get("date") || getToday());
  const [highlightId, setHighlightId] = useState<string | null>(searchParams.get("highlight"));
  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [reservationList, setReservationList] = useState<Reservation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [staffList, setStaffList] = useState<Staff[]>([]);

  // Business hours state
  const [businessHours, setBusinessHours] = useState<StaffBusinessHours[]>([]);
  const [allStaffBusinessHoursMap, setAllStaffBusinessHoursMap] = useState<Map<string, StaffBusinessHours[]>>(new Map());
  const [storeBusinessHours, setStoreBusinessHours] = useState<StaffBusinessHours[]>([]);
  const [holidayHoursEnabled, setHolidayHoursEnabled] = useState(false);

  // Helper: get effective day_of_week considering holidays
  const getEffectiveDayOfWeek = useCallback((dateStr: string) => {
    const dayOfWeek = new Date(dateStr + "T00:00:00").getDay();
    if (holidayHoursEnabled && isJapaneseHoliday(dateStr)) return 7;
    return dayOfWeek;
  }, [holidayHoursEnabled]);

  // Helper: find business hours for a date, falling back to store holiday hours if needed
  const findHoursForDate = useCallback((hours: StaffBusinessHours[], dateStr: string, opts?: { excludeClosed?: boolean }) => {
    const effectiveDow = getEffectiveDayOfWeek(dateStr);
    let found = hours.find((h) => h.day_of_week === effectiveDow && (!opts?.excludeClosed || !h.is_closed));
    // If holiday (dow=7) not found in staff hours, fall back to store holiday hours
    if (!found && effectiveDow === 7) {
      found = storeBusinessHours.find((h) => h.day_of_week === 7 && (!opts?.excludeClosed || !h.is_closed));
    }
    return found;
  }, [getEffectiveDayOfWeek, storeBusinessHours]);

  // Staff blocks state
  const [blockList, setBlockList] = useState<StaffBlock[]>([]);
  const [showBlockDialog, setShowBlockDialog] = useState(false);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [selectedBlock, setSelectedBlock] = useState<StaffBlock | null>(null);
  const [blockDate, setBlockDate] = useState(selectedDate);
  const [blockIsAllDay, setBlockIsAllDay] = useState(true);
  const [blockStartTime, setBlockStartTime] = useState("10:00");
  const [blockEndTime, setBlockEndTime] = useState("18:00");
  const [blockReason, setBlockReason] = useState("");

  // Equipment data for canDrop validation
  const [menuEquipmentMap, setMenuEquipmentMap] = useState<Record<string, string[]>>({});
  const [equipmentQuantities, setEquipmentQuantities] = useState<Record<string, number>>({});

  // Category colors: category name → hex color, menu ID → category name
  const [categoryColors, setCategoryColors] = useState<Record<string, string>>({});
  const [menuCategoryMap, setMenuCategoryMap] = useState<Record<string, string>>({});

  // Self/Store scope toggle
  const [showAll, setShowAll] = useState(false);

  // Drag & drop
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const weekScrollContainerRef = useRef<HTMLDivElement>(null);
  const activeScrollRef = viewMode === "week" ? weekScrollContainerRef : scrollContainerRef;
  const dragSlotHeight = viewMode === "week" ? 5 : 7;

  const resolveDateFromX = useCallback((clientX: number): string | null => {
    if (viewMode !== "week") return null;
    const columns = document.querySelectorAll<HTMLElement>("[data-drag-date]");
    for (const col of columns) {
      const rect = col.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right) {
        return col.dataset.dragDate || null;
      }
    }
    return null;
  }, [viewMode]);

  const canDropRef = useRef<((reservationId: string, date: string, slotsFromTop: number, slotsHeight: number) => boolean) | null>(null);

  const {
    dragPreview,
    isUpdating: dragUpdating,
    justFinishedDragRef,
    handlePointerDown,
  } = useReservationDrag({
    slotHeight: dragSlotHeight,
    scrollContainerRef: activeScrollRef,
    resolveDateFromX,
    canDrop: (reservationId, date, slotsFromTop, slotsHeight) => {
      return canDropRef.current ? canDropRef.current(reservationId, date, slotsFromTop, slotsHeight) : true;
    },
    onDrop: async (reservationId, newStartAt, newEndAt) => {
      try {
        await reservations.update(reservationId, { start_at: newStartAt, end_at: newEndAt });
        await fetchReservations();
      } catch (error) {
        console.error("Failed to move reservation:", error);
        await fetchReservations();
      }
    },
  });

  // Time slots for calendar grid (6:30 - 22:30, 5-min intervals)
  const timeSlots = useMemo(() => {
    const slots: { hour: number; minute: number; label: string }[] = [];
    for (let hour = 6; hour <= 22; hour++) {
      for (let minute = 0; minute < 60; minute += 5) {
        if (hour === 6 && minute < 30) continue; // Start at 6:30
        if (hour === 22 && minute > 30) break;
        slots.push({
          hour,
          minute,
          label: `${hour}:${minute.toString().padStart(2, "0")}`,
        });
      }
    }
    return slots;
  }, []);

  // Calculate date range based on view mode
  const dateRange = useMemo(() => {
    const base = new Date(selectedDate + "T00:00:00");
    const start = new Date(base);
    const end = new Date(base);

    if (viewMode === "week") {
      const day = start.getDay();
      const diff = day === 0 ? -6 : 1 - day; // Start from Monday
      start.setDate(start.getDate() + diff);
      end.setTime(start.getTime());
      end.setDate(end.getDate() + 6);
    } else if (viewMode === "month") {
      start.setDate(1);
      end.setMonth(end.getMonth() + 1);
      end.setDate(0);
    }

    return {
      start: formatDateLocal(start),
      end: formatDateLocal(end),
    };
  }, [selectedDate, viewMode]);

  // Client-side staff filter (safety net for race conditions when toggling self/store)
  const staffFilteredReservations = useMemo(() => {
    if (showAll) return reservationList;
    if (!staff) return [];
    return reservationList.filter((r) => r.staff_id === staff.id);
  }, [reservationList, showAll, staff]);

  // Active reservations (exclude cancelled/noshow)
  const activeReservations = useMemo(
    () => staffFilteredReservations.filter((r) => !["cancelled", "noshow"].includes(r.status)),
    [staffFilteredReservations]
  );

  // Group reservations by date for week/month views
  const reservationsByDate = useMemo(() => {
    const grouped: Record<string, Reservation[]> = {};
    activeReservations.forEach((r) => {
      const dateKey = toJSTDateKey(r.start_at);
      if (!grouped[dateKey]) grouped[dateKey] = [];
      grouped[dateKey].push(r);
    });
    Object.keys(grouped).forEach((date) => {
      grouped[date].sort((a, b) => a.start_at.localeCompare(b.start_at));
    });
    return grouped;
  }, [activeReservations]);

  // Generate calendar days for month view
  const calendarDays = useMemo(() => {
    if (viewMode !== "month") return [];
    const base = new Date(selectedDate + "T00:00:00");
    const year = base.getFullYear();
    const month = base.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDay = firstDay.getDay();
    const daysInMonth = lastDay.getDate();

    const days: { date: Date; isCurrentMonth: boolean }[] = [];

    // Previous month days
    const prevMonthLastDay = new Date(year, month, 0).getDate();
    for (let i = startDay - 1; i >= 0; i--) {
      days.push({ date: new Date(year, month - 1, prevMonthLastDay - i), isCurrentMonth: false });
    }

    // Current month days
    for (let i = 1; i <= daysInMonth; i++) {
      days.push({ date: new Date(year, month, i), isCurrentMonth: true });
    }

    // Next month days (fill to 42 = 6 rows)
    const remaining = 42 - days.length;
    for (let i = 1; i <= remaining; i++) {
      days.push({ date: new Date(year, month + 1, i), isCurrentMonth: false });
    }

    return days;
  }, [selectedDate, viewMode]);

  // Generate week days for week view
  const weekDays = useMemo(() => {
    if (viewMode !== "week") return [];
    const days: Date[] = [];
    const start = new Date(dateRange.start + "T00:00:00");
    for (let i = 0; i < 7; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      days.push(day);
    }
    return days;
  }, [dateRange.start, viewMode]);

  const fetchReservations = useCallback(async () => {
    if (!currentStore) {
      setReservationList([]);
      return;
    }
    // Don't fetch in self mode until staff is loaded
    if (!showAll && !staff) {
      return;
    }
    try {
      const params: { store_id: string; date?: string; start_date?: string; end_date?: string; staff_id?: string } = {
        store_id: currentStore.id,
      };
      if (viewMode === "day") {
        params.date = selectedDate;
      } else {
        params.start_date = dateRange.start;
        params.end_date = dateRange.end;
      }
      if (!showAll && staff) {
        params.staff_id = staff.id;
      }
      const { reservations: data } = await reservations.list(params);
      const sorted = [...data].sort(
        (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
      );
      setReservationList(sorted);
    } catch (error) {
      console.error("Failed to fetch reservations:", error);
    }
  }, [currentStore, selectedDate, viewMode, dateRange, showAll, staff]);

  const fetchBlocks = useCallback(async () => {
    if (!staff) return;
    try {
      const params: { staff_id?: string; store_id?: string; date_from: string; date_to: string } = {
        date_from: dateRange.start,
        date_to: dateRange.end,
      };
      if (showAll && currentStore && staff.role !== 'staff') {
        // Fetch blocks for all staff in the store
        params.store_id = currentStore.id;
      } else {
        // Fetch blocks for the current user only
        params.staff_id = staff.id;
        if (currentStore) {
          params.store_id = currentStore.id;
        }
      }
      const { blocks } = await staffBlocks.list(params);
      setBlockList(blocks);
    } catch (error) {
      console.error("Failed to fetch blocks:", error);
    }
  }, [staff, currentStore, dateRange, showAll]);

  const fetchBusinessHours = useCallback(async () => {
    if (!staff || !currentStore) return;
    try {
      const [staffHoursRes, storeData] = await Promise.all([
        staffSettings.getBusinessHours(staff.id, currentStore.id),
        storesApi.get(currentStore.id),
      ]);

      // Always set store business hours
      const storeHours = storeData.business_hours;
      if (storeHours && storeHours.length > 0) {
        const mapped = storeHours.map((h) => ({
          day_of_week: h.day_of_week,
          open_time: h.open_time,
          close_time: h.close_time,
          is_closed: h.is_closed,
        }));
        setStoreBusinessHours(mapped);
        setHolidayHoursEnabled(!!((storeData as any).store?.holiday_hours_enabled ?? (storeData as any).holiday_hours_enabled));

        if (staffHoursRes.business_hours.length > 0) {
          setBusinessHours(staffHoursRes.business_hours);
        } else {
          setBusinessHours(mapped);
        }
      } else if (staffHoursRes.business_hours.length > 0) {
        setBusinessHours(staffHoursRes.business_hours);
      }
    } catch (error) {
      console.error("Failed to fetch business hours:", error);
    }
  }, [staff, currentStore]);

  const fetchEquipmentMappings = useCallback(async () => {
    if (!currentStore) return;
    try {
      const { mappings, quantities } = await equipmentApi.menuMappings(currentStore.id);
      setMenuEquipmentMap(mappings);
      setEquipmentQuantities(quantities);
    } catch (error) {
      console.error("Failed to fetch equipment mappings:", error);
    }
  }, [currentStore]);

  // Fetch staff list, per-staff business hours, and category colors
  useEffect(() => {
    if (!currentStore) return;
    staffApi.list(currentStore.id).then(async ({ staff: list }) => {
      const filtered = list.filter((s) => s.is_active && s.is_visible_to_customer);
      // Always include the logged-in user even if not visible to customer
      if (staff && !filtered.some(s => s.id === staff.id)) {
        const me = list.find(s => s.id === staff.id && s.is_active);
        if (me) filtered.push(me);
      }
      setStaffList(filtered);
      // Fetch per-staff business hours for all staff
      const hoursMap = new Map<string, StaffBusinessHours[]>();
      await Promise.all(
        filtered.map(async (s) => {
          try {
            const res = await staffSettings.getBusinessHours(s.id, currentStore.id);
            if (res.business_hours.length > 0) {
              hoursMap.set(s.id, res.business_hours);
            }
          } catch {
            // ignore
          }
        })
      );
      setAllStaffBusinessHoursMap(hoursMap);
    }).catch(console.error);
    menusApi.list(currentStore.id, false).then(({ menus: menuList, categoryColors: colors }) => {
      setCategoryColors(colors);
      const catMap: Record<string, string> = {};
      for (const m of menuList) {
        catMap[m.id] = m.category;
      }
      setMenuCategoryMap(catMap);
    }).catch(console.error);
  }, [currentStore?.id, staff?.id]);

  useEffect(() => {
    const fetchAll = async () => {
      setIsLoading(true);
      await Promise.all([fetchReservations(), fetchBlocks(), fetchBusinessHours(), fetchEquipmentMappings()]);
      setIsLoading(false);
    };
    fetchAll();
  }, [fetchReservations, fetchBlocks, fetchBusinessHours, fetchEquipmentMappings]);

  // Scroll to 30min before business hours opening time after data loads
  useEffect(() => {
    if (isLoading || businessHours.length === 0) return;
    const dayHours = findHoursForDate(businessHours, selectedDate, { excludeClosed: true });
    if (!dayHours?.open_time) return;
    const [oh, om] = dayHours.open_time.split(":").map(Number);
    // 30min before opening, minus grid start (6:30)
    const openMinutes = oh * 60 + om - 30; // 30min before
    const gridStartMinutes = 6 * 60 + 30; // grid starts at 6:30
    const offsetMinutes = Math.max(0, openMinutes - gridStartMinutes);
    const slots = offsetMinutes / 5;
    const container = viewMode === "week" ? weekScrollContainerRef.current : scrollContainerRef.current;
    if (container) {
      const slotH = viewMode === "week" ? 5 : 7;
      container.scrollTop = slots * slotH;

      // Week view: scroll horizontally to today's column
      if (viewMode === "week") {
        const today = new Date();
        const day = today.getDay(); // 0=Sun, 1=Mon, ...
        const mondayIndex = day === 0 ? 6 : day - 1; // Convert to Mon=0, Tue=1, ..., Sun=6
        const timeColWidth = 38; // w-[38px] time column
        const gridWidth = container.scrollWidth - timeColWidth;
        const colWidth = gridWidth / 7;
        container.scrollLeft = Math.max(0, mondayIndex * colWidth - colWidth * 0.1);
      }
    }
  }, [isLoading, businessHours, viewMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to and highlight newly created reservation
  useEffect(() => {
    if (!highlightId || isLoading) return;
    // Wait for DOM to render
    const timer = setTimeout(() => {
      const el = document.querySelector(`[data-reservation-id="${highlightId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      // Clear highlight after 3 seconds
      const clearTimer = setTimeout(() => {
        setHighlightId(null);
        window.history.replaceState({}, "", `/reservations?date=${selectedDate}`);
      }, 3000);
      return () => clearTimeout(clearTimer);
    }, 300);
    return () => clearTimeout(timer);
  }, [highlightId, isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Open block dialog if redirected from new reservation page
  useEffect(() => {
    if (searchParams.get("openBlock") === "true") {
      openBlockDialog();
      // Clean up URL
      window.history.replaceState({}, "", "/reservations");
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Date navigation
  const handleNavigate = (direction: number) => {
    const date = new Date(selectedDate + "T00:00:00");
    if (viewMode === "day") {
      date.setDate(date.getDate() + direction);
    } else if (viewMode === "week") {
      date.setDate(date.getDate() + direction * 7);
    } else if (viewMode === "month") {
      date.setMonth(date.getMonth() + direction);
    }
    setSelectedDate(formatDateLocal(date));
  };
  const goToToday = () => setSelectedDate(getToday());
  const swipeHandlersRaw = useSwipeNavigation(handleNavigate);
  // Disable swipe navigation only in store+day mode so horizontal scroll works for staff columns
  const swipeHandlers = viewMode === "week" || (showAll && viewMode === "day") ? {} : swipeHandlersRaw;

  const displayDate = useMemo(() => {
    const base = new Date(selectedDate + "T00:00:00");
    if (viewMode === "month") {
      return `${base.getFullYear()}年${base.getMonth() + 1}月`;
    }
    if (viewMode === "week") {
      const start = new Date(dateRange.start + "T00:00:00");
      const end = new Date(dateRange.end + "T00:00:00");
      return `${start.getMonth() + 1}/${start.getDate()} - ${end.getMonth() + 1}/${end.getDate()}`;
    }
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
    return `${base.getMonth() + 1}/${base.getDate()}(${dayNames[base.getDay()]})`;
  }, [selectedDate, viewMode, dateRange]);

  // Filtered staff list for day view (self vs store)
  const displayStaffList = useMemo(() => {
    if (showAll || !staff) return staffList;
    return staffList.filter(s => s.id === staff.id);
  }, [showAll, staff, staffList]);

  // Long press handling for grid cells
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);
  const startLongPress = useCallback((callback: () => void) => {
    clearLongPress();
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      callback();
    }, 500);
  }, [clearLongPress]);
  useEffect(() => {
    return () => { clearLongPress(); };
  }, [clearLongPress]);

  // Drag-create: shared for week and day views
  const CREATE_SLOTS = 12; // 1 hour = 12 × 5-min slots
  const TOTAL_SLOTS = 192; // 6:30-22:30

  const [dragCreatePreview, setDragCreatePreview] = useState<{
    dateKey: string;
    slotsFromTop: number;
    staffId?: string; // day view only
  } | null>(null);
  const dragCreateRef = useRef<{
    startSlot: number;
    startY: number;
    initialScrollTop: number;
    dateKey: string;
    slotH: number; // px per slot (5 for week, CSS var for day)
    scrollRef: React.RefObject<HTMLElement | null>;
    staffId?: string;
  } | null>(null);
  const dragCreateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDragCreateTimer = useCallback(() => {
    if (dragCreateTimerRef.current) {
      clearTimeout(dragCreateTimerRef.current);
      dragCreateTimerRef.current = null;
    }
  }, []);

  const handleDragCreateDown = useCallback((
    e: React.PointerEvent, dateKey: string, hour: number, minute: number,
    slotH: number, scrollRef: React.RefObject<HTMLElement | null>, staffId?: string
  ) => {
    if (e.button !== 0) return;
    const startY = e.clientY;
    const startSlot = ((hour - 6) * 60 + minute - 30) / 5;
    clearDragCreateTimer();
    dragCreateTimerRef.current = setTimeout(() => {
      dragCreateTimerRef.current = null;
      window.getSelection()?.removeAllRanges();
      const container = scrollRef.current;
      dragCreateRef.current = {
        startSlot, startY, slotH, scrollRef, staffId, dateKey,
        initialScrollTop: container ? container.scrollTop : 0,
      };
      setDragCreatePreview({
        dateKey, staffId,
        slotsFromTop: Math.max(0, startSlot - (CREATE_SLOTS - 1)),
      });
      if (navigator.vibrate) navigator.vibrate(50);
    }, 500);
  }, [clearDragCreateTimer]);

  useEffect(() => {
    if (!dragCreatePreview) return;

    const handleMove = (e: PointerEvent) => {
      const state = dragCreateRef.current;
      if (!state) return;
      const container = state.scrollRef.current;
      const scrollDelta = container ? container.scrollTop - state.initialScrollTop : 0;
      const deltaY = e.clientY - state.startY + scrollDelta;
      const deltaSlots = Math.round(deltaY / state.slotH);
      const fingerSlot = state.startSlot + deltaSlots;
      const newSlot = Math.max(0, Math.min(TOTAL_SLOTS - CREATE_SLOTS, fingerSlot - (CREATE_SLOTS - 1)));

      // Detect column change (date for week view, staff for day view)
      let dateKey = state.dateKey;
      let staffId = state.staffId;
      const columns = document.querySelectorAll<HTMLElement>("[data-drag-date]");
      for (const col of columns) {
        const rect = col.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right) {
          dateKey = col.dataset.dragDate || state.dateKey;
          staffId = col.dataset.dragStaff || state.staffId;
          break;
        }
      }

      setDragCreatePreview({ dateKey, slotsFromTop: newSlot, staffId });
    };

    const handleUp = () => {
      const preview = dragCreatePreview;
      setDragCreatePreview(null);
      dragCreateRef.current = null;
      if (preview) {
        const totalMinutes = preview.slotsFromTop * 5 + 6 * 60 + 30;
        const hour = Math.floor(totalMinutes / 60);
        const minute = totalMinutes % 60;
        const time = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
        const staffParam = preview.staffId ? `&staff_id=${preview.staffId}` : "";
        router.push(`/reservations/new?date=${preview.dateKey}&time=${time}${staffParam}`);
      }
    };

    const handleCancel = () => {
      setDragCreatePreview(null);
      dragCreateRef.current = null;
    };

    const preventScroll = (e: TouchEvent) => { e.preventDefault(); };
    document.addEventListener("touchmove", preventScroll, { passive: false });
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleCancel);
    return () => {
      document.removeEventListener("touchmove", preventScroll);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleCancel);
    };
  }, [dragCreatePreview]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => { clearDragCreateTimer(); };
  }, [clearDragCreateTimer]);

  // Tap handler for calendar slots
  const handleSlotClick = (hour: number, minute: number, staffId?: string) => {
    if (!currentStore) return;
    window.getSelection()?.removeAllRanges();
    const time = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
    const params = new URLSearchParams({ date: selectedDate, time });
    if (staffId) params.set("staff_id", staffId);
    router.push(`/reservations/new?${params.toString()}`);
  };

  // Get slot status for a specific date (used in week view)
  const getSlotStatusForDate = (dateStr: string, hour: number, minute: number): "available" | "blocked" | "closed" | "outside_hours" => {
    // Check blocks for this specific date
    const slotTime = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
    const slotEndMin = hour * 60 + minute + 5;
    const slotEndTime = `${Math.floor(slotEndMin / 60).toString().padStart(2, "0")}:${(slotEndMin % 60).toString().padStart(2, "0")}`;
    for (const block of myBlocks) {
      if (block.date !== dateStr) continue;
      if (block.is_all_day && !showAll) return "blocked";
      if (block.start_time && block.end_time) {
        if (block.start_time < slotEndTime && block.end_time > slotTime) return "blocked";
      }
    }
    // Check business hours - use store hours in showAll mode
    const effectiveHours = showAll ? storeBusinessHours : businessHours;
    if (effectiveHours.length === 0) return "available";
    const dayHours = findHoursForDate(effectiveHours, dateStr);
    if (!dayHours) return "available";
    if (dayHours.is_closed) return "closed";
    if (dayHours.open_time && dayHours.close_time) {
      if (slotTime < dayHours.open_time || slotTime >= dayHours.close_time) return "outside_hours";
    }
    return "available";
  };

  // canDrop: check all slots in the reservation range are available for the reservation's staff
  canDropRef.current = (reservationId: string, date: string, slotsFromTopVal: number, slotsHeightVal: number) => {
    // Find the reservation's staff_id to check their blocks
    const reservation = reservationList.find(r => r.id === reservationId);
    const staffId = reservation?.staff_id;
    const staffBlocksForCheck = staffId ? blockList.filter(b => b.staff_id === staffId) : myBlocks;

    for (let i = 0; i < slotsHeightVal; i++) {
      const { hour, minute } = slotsToTime(slotsFromTopVal + i);
      const slotTime = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
      const slotEndMin = hour * 60 + minute + 5;
      const slotEndTime = `${Math.floor(slotEndMin / 60).toString().padStart(2, "0")}:${(slotEndMin % 60).toString().padStart(2, "0")}`;

      // Check blocks for this staff
      for (const block of staffBlocksForCheck) {
        if (block.date !== date) continue;
        if (block.is_all_day) return false;
        if (block.start_time && block.end_time) {
          if (block.start_time < slotEndTime && block.end_time > slotTime) return false;
        }
      }

      // Check business hours
      if (businessHours.length > 0) {
        const dayHours = findHoursForDate(businessHours, date);
        if (dayHours?.is_closed) return false;
        if (dayHours?.open_time && dayHours?.close_time) {
          if (slotTime < dayHours.open_time || slotTime >= dayHours.close_time) return false;
        }
      }
    }

    // Check equipment availability at the new time range
    if (reservation && Object.keys(menuEquipmentMap).length > 0) {
      // Collect all equipment IDs needed by this reservation's menus
      const menuIds = reservation.menus?.map(m => m.id) || (reservation.menu_id ? [reservation.menu_id] : []);
      const requiredEquipmentIds = new Set<string>();
      for (const mid of menuIds) {
        const eqIds = menuEquipmentMap[mid];
        if (eqIds) eqIds.forEach(id => requiredEquipmentIds.add(id));
      }

      if (requiredEquipmentIds.size > 0) {
        // Calculate the new time range in UTC ISO format for comparison
        const newStart = slotsToTime(slotsFromTopVal);
        const newEnd = slotsToTime(slotsFromTopVal + slotsHeightVal);
        const newStartAt = `${date}T${String(newStart.hour).padStart(2, "0")}:${String(newStart.minute).padStart(2, "0")}:00+09:00`;
        const newEndAt = `${date}T${String(newEnd.hour).padStart(2, "0")}:${String(newEnd.minute).padStart(2, "0")}:00+09:00`;
        const newStartMs = new Date(newStartAt).getTime();
        const newEndMs = new Date(newEndAt).getTime();

        // For each required equipment, count overlapping reservations (excluding self)
        for (const eqId of requiredEquipmentIds) {
          const quantity = equipmentQuantities[eqId] || 0;
          let usage = 0;
          for (const r of reservationList) {
            if (r.id === reservationId) continue;
            if (r.status === "cancelled" || r.status === "noshow") continue;
            // Check if this reservation uses the same equipment
            const rMenuIds = r.menus?.map(m => m.id) || (r.menu_id ? [r.menu_id] : []);
            const usesEquipment = rMenuIds.some(mid => menuEquipmentMap[mid]?.includes(eqId));
            if (!usesEquipment) continue;
            // Check time overlap
            const rStartMs = new Date(r.start_at).getTime();
            const rEndMs = new Date(r.end_at).getTime();
            if (rStartMs < newEndMs && rEndMs > newStartMs) {
              usage++;
            }
          }
          if (usage >= quantity) return false;
        }
      }
    }

    return true;
  };


  // Block handlers
  const openBlockDialog = (block?: StaffBlock) => {
    if (block) {
      setEditingBlockId(block.id);
      setBlockDate(block.date);
      setBlockIsAllDay(block.is_all_day === 1);
      setBlockStartTime(block.start_time || "10:00");
      setBlockEndTime(block.end_time || "18:00");
      setBlockReason(block.reason || "");
    } else {
      setEditingBlockId(null);
      setBlockDate(selectedDate);
      setBlockIsAllDay(false);
      setBlockStartTime("10:00");
      setBlockEndTime("18:00");
      setBlockReason("");
    }
    setShowBlockDialog(true);
  };

  const handleSaveBlock = async () => {
    if (!staff) return;
    setActionLoading(true);
    try {
      const data = {
        store_id: currentStore?.id || null,
        date: blockDate,
        is_all_day: blockIsAllDay,
        start_time: blockIsAllDay ? undefined : blockStartTime,
        end_time: blockIsAllDay ? undefined : blockEndTime,
        reason: blockReason || undefined,
      };
      if (editingBlockId) {
        await staffBlocks.update(editingBlockId, { ...data, is_all_day: blockIsAllDay ? 1 : 0 });
      } else {
        await staffBlocks.create(data);
      }
      setShowBlockDialog(false);
      setSelectedBlock(null);
      await fetchBlocks();
    } catch (error) {
      console.error("Failed to save block:", error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteBlock = async (id: string) => {
    setActionLoading(true);
    try {
      await staffBlocks.delete(id);
      setSelectedBlock(null);
      await fetchBlocks();
    } catch (error) {
      console.error("Failed to delete block:", error);
    } finally {
      setActionLoading(false);
    }
  };

  // Current user's blocks (filtered from blockList which may contain all staff's blocks)
  const myBlocks = useMemo(() =>
    blockList.filter(b => b.staff_id === staff?.id),
    [blockList, staff]
  );

  // Whether the current user may edit a given block (mirrors backend: regular staff
  // can only edit their own; manager/owner/admin can edit any block in the store).
  const canEditBlock = useCallback((b: StaffBlock) =>
    staff?.role !== "staff" || b.staff_id === staff?.id,
    [staff]
  );

  // Helper: get blocks for a specific staff member on the selected date
  const getStaffBlocks = useCallback((staffId: string) =>
    blockList.filter(b => b.staff_id === staffId),
    [blockList]
  );

  // Get category color style for a reservation
  const getReservationStyle = useCallback((reservation: Reservation) => {
    const menuId = reservation.menus?.[0]?.id || reservation.menu_id;
    const category = menuId ? menuCategoryMap[menuId] : undefined;
    const hex = category ? categoryColors[category] : undefined;
    return hexToStyle(hex || DEFAULT_CATEGORY_COLOR, reservation.status);
  }, [categoryColors, menuCategoryMap]);


  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">予約管理</h1>
        <div className="flex items-center gap-2">
          {staff && (
            <div className="flex rounded-lg border overflow-hidden">
              <button
                className={`px-3 py-1 text-xs font-medium transition-colors ${
                  !showAll ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
                onClick={() => setShowAll(false)}
              >
                自分
              </button>
              <button
                className={`px-3 py-1 text-xs font-medium transition-colors border-l ${
                  showAll ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
                onClick={() => setShowAll(true)}
              >
                店舗
              </button>
            </div>
          )}
          {currentStore && (
            <Button size="sm" onClick={() => router.push(`/reservations/new?date=${selectedDate}`)}>
              <Plus className="mr-1 h-4 w-4" />
              新規
            </Button>
          )}
        </div>
      </div>

      {/* Date Navigation & View Mode */}
      <Card className="p-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-0.5">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleNavigate(-1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" className="text-xs h-7 px-2" onClick={goToToday}>
              今日
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleNavigate(1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <span className="font-medium text-sm ml-1">{displayDate}</span>
          </div>
          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)}>
            <TabsList className="h-7">
              <TabsTrigger value="day" className="text-xs px-2 h-6">日</TabsTrigger>
              <TabsTrigger value="week" className="text-xs px-2 h-6">週</TabsTrigger>
              <TabsTrigger value="month" className="text-xs px-2 h-6">月</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </Card>

      {/* Block cards removed - blocks are shown inline on the calendar grid */}

      {/* Calendar Views */}
      <div {...swipeHandlers}>
      {isLoading ? (
        <div className="py-12 text-center text-muted-foreground">読み込み中...</div>
      ) : viewMode === "month" ? (
        /* Month View */
        <Card className="overflow-hidden p-2">
          <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden">
            {/* Header */}
            {["日", "月", "火", "水", "木", "金", "土"].map((day, i) => (
              <div
                key={day}
                className={cn(
                  "bg-muted p-1.5 text-center text-xs font-medium",
                  i === 0 && "text-red-500",
                  i === 6 && "text-blue-500"
                )}
              >
                {day}
              </div>
            ))}
            {/* Days */}
            {calendarDays.map(({ date, isCurrentMonth }, index) => {
              const dateKey = formatDateLocal(date);
              const dayReservations = reservationsByDate[dateKey] || [];
              const isDateToday = isSameDay(date, getToday());
              // Check if day is closed/off
              const effectiveMonthHours = showAll ? storeBusinessHours : businessHours;
              const monthDayHours = findHoursForDate(effectiveMonthHours, dateKey);
              const isDayClosed = !!monthDayHours?.is_closed;
              const hasAllDayBlock = !showAll && myBlocks.some(b => b.date === dateKey && b.is_all_day);
              const isDayOff = isDayClosed || hasAllDayBlock;

              return (
                <div
                  key={index}
                  className={cn(
                    "bg-card min-h-[72px] p-1 cursor-pointer hover:bg-muted/50",
                    !isCurrentMonth && "bg-muted/50",
                    isDateToday && "bg-primary/5",
                    isDayOff && "bg-gray-200/60"
                  )}
                  onClick={() => {
                    setSelectedDate(formatDateLocal(date));
                    setViewMode("day");
                  }}
                >
                  <div
                    className={cn(
                      "text-xs font-medium mb-0.5",
                      !isCurrentMonth && "text-muted-foreground",
                      date.getDay() === 0 && "text-red-500",
                      date.getDay() === 6 && "text-blue-500",
                      isDateToday && "bg-primary text-white rounded-full w-5 h-5 flex items-center justify-center text-[10px]"
                    )}
                  >
                    {date.getDate()}
                  </div>
                  <div className="space-y-0.5">
                    {dayReservations.slice(0, 2).map((r) => {
                      const monthStyle = getReservationStyle(r);
                      return (
                      <div
                        key={r.id}
                        className={cn(
                          "text-[9px] px-0.5 rounded border overflow-hidden",
                          (r.status === "cancelled" || r.status === "noshow") && "line-through"
                        )}
                        style={monthStyle}
                      >
                        <div className="flex items-center gap-0.5">
                          {(r.is_new_customer != null ? r.is_new_customer === 1 : r.customer_visit_count === 0) && (
                            <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[11px] text-white rounded-sm shrink-0" style={{ backgroundColor: "#3A76FD" }}>新</span>
                          )}
                          {r.source === "hotpepper" && (
                            <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[11px] text-white rounded-sm shrink-0" style={{ backgroundColor: "#CB006D" }}>HPB</span>
                          )}
                          {r.source === "minimo" && (
                            <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[11px] text-white rounded-sm shrink-0" style={{ backgroundColor: "#00A7FF" }}>mini</span>
                          )}
                        </div>
                        <div className="truncate" style={{ color: "#1a1a1a" }}>{r.customer_name}</div>
                        <div className="truncate text-[8px]" style={{ color: "#1a1a1a" }}>{formatDate(r.start_at, "time")}</div>
                      </div>
                      );
                    })}
                    {dayReservations.length > 2 && (
                      <div className="text-[9px] text-muted-foreground px-0.5">
                        +{dayReservations.length - 2}件
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      ) : viewMode === "week" ? (
        /* Week View */
        <Card className="overflow-hidden">
          <div ref={weekScrollContainerRef} className={cn("max-h-[calc(100vh-240px)]", showAll ? "overflow-auto" : "overflow-y-auto")}>
            <div
              style={
                showAll
                  ? { minWidth: `${Math.max(1000, 7 * Math.max(displayStaffList.length, 1) * 56)}px` }
                  : undefined
              }
            >
              {/* Header */}
              <div className="flex border-b sticky top-0 z-20 bg-background">
                <div className="w-[38px] shrink-0 p-1.5 sticky left-0 z-30 bg-background" />
                <div className="flex-1 grid grid-cols-7">
                  {weekDays.map((day, i) => {
                    const isDateToday = isSameDay(day, getToday());
                    return (
                      <div
                        key={i}
                        className={cn(
                          "p-1.5 text-center border-l cursor-pointer hover:bg-muted/50",
                          isDateToday && "bg-primary/5"
                        )}
                        onClick={() => {
                          setSelectedDate(formatDateLocal(day));
                          setViewMode("day");
                        }}
                      >
                        <div className={cn(
                          "text-[10px] text-muted-foreground",
                          day.getDay() === 0 && "text-red-500",
                          day.getDay() === 6 && "text-blue-500"
                        )}>
                          {["日", "月", "火", "水", "木", "金", "土"][day.getDay()]}
                        </div>
                        <div className={cn(
                          "text-xs font-medium",
                          isDateToday && "bg-primary text-white rounded-full w-5 h-5 mx-auto flex items-center justify-center text-[10px]"
                        )}>
                          {day.getDate()}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              {/* Time slots */}
              <div className="flex">
                  {/* Time labels column */}
                  <div className="w-[38px] shrink-0 sticky left-0 z-20 bg-background">
                    {timeSlots.map((slot) => (
                      <div key={slot.label} className="relative h-[5px]">
                        {slot.minute === 0 && (
                          <span className="absolute -top-[7px] left-0 right-0 text-center text-[10px] font-medium text-muted-foreground leading-none z-10">
                            {slot.label}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                  {/* Day columns */}
                  <div className="flex-1 grid grid-cols-7">
                    {weekDays.map((day, dayIndex) => {
                      const dateKey = formatDateLocal(day);
                      const dayReservations = reservationsByDate[dateKey] || [];

                      // Build block items for overlap calculation
                      const dayBlocks: { block: StaffBlock; staffMember: Staff; blockId: string; top: number; bottom: number }[] = [];
                      {
                        const dayHoursW = findHoursForDate(businessHours, dateKey, { excludeClosed: true });
                        const openW = dayHoursW?.open_time || "10:00";
                        const closeW = dayHoursW?.close_time || "20:00";
                        const [owh, owm] = openW.split(":").map(Number);
                        const [cwh, cwm] = closeW.split(":").map(Number);
                        const wStartOff = (owh - 6) * 60 + owm - 30;
                        const wEndOff = (cwh - 6) * 60 + cwm - 30;
                        // Self ("自分") mode: show only the current user's own blocks; store mode: all staff.
                        for (const b of (showAll ? blockList : myBlocks).filter(bl => bl.date === dateKey)) {
                          const s = staffList.find(st => st.id === b.staff_id) || staff;
                          if (!s) continue;
                          let top: number, bottom: number;
                          if (b.is_all_day) {
                            top = wStartOff;
                            bottom = wEndOff;
                          } else if (b.start_time && b.end_time) {
                            const [bsh, bsm] = b.start_time.split(":").map(Number);
                            const [beh, bem] = b.end_time.split(":").map(Number);
                            top = (bsh - 6) * 60 + bsm - 30;
                            bottom = (beh - 6) * 60 + bem - 30;
                          } else continue;
                          if (bottom <= top) continue;
                          const blockId = `block-${b.id}`;
                          dayBlocks.push({ block: b, staffMember: s, blockId, top, bottom });
                        }
                      }

                      // Calculate overlap layout for side-by-side display (reservations + blocks together)
                      const reservationItems = dayReservations
                        .filter(r => r.start_at && r.end_at)
                        .map(r => {
                          const s = toJST(r.start_at);
                          const e = toJST(r.end_at);
                          return { id: r.id, top: (s.hour - 6) * 60 + s.minute - 30, bottom: (e.hour - 6) * 60 + e.minute - 30 };
                        })
                        .filter(item => item.bottom > item.top);
                      const blockItems = dayBlocks.map(db => ({ id: db.blockId, top: db.top, bottom: db.bottom }));
                      const weekOverlap = layoutOverlapping([...reservationItems, ...blockItems]);

                      return (
                        <div key={dayIndex} className="relative border-l" data-drag-date={dateKey}>
                          {/* Slot backgrounds */}
                          {timeSlots.map((slot) => {
                            const status = getSlotStatusForDate(dateKey, slot.hour, slot.minute);
                            return (
                              <div
                                key={slot.label}
                                className={cn(
                                  "h-[5px] cursor-pointer",
                                  slot.minute === 55 ? "border-b border-b-border" : slot.minute % 30 === 25 ? "border-b border-b-border/30" : "",
                                  status !== "available" ? "bg-gray-200/60" : "hover:bg-muted/30"
                                )}
                                style={{ userSelect: "none", WebkitUserSelect: "none" }}
                                onPointerDown={(e) => {
                                  if (status === "closed" || status === "blocked") return;
                                  handleDragCreateDown(e, dateKey, slot.hour, slot.minute, 5, weekScrollContainerRef);
                                }}
                                onPointerUp={clearDragCreateTimer}
                                onPointerCancel={clearDragCreateTimer}
                                onContextMenu={(e) => e.preventDefault()}
                              />
                            );
                          })}
                          {/* Reservation overlays */}
                          {dayReservations.map((reservation) => {
                            if (!reservation.start_at || !reservation.end_at) return null;
                            const start = toJST(reservation.start_at);
                            const end = toJST(reservation.end_at);
                            const startOffset = (start.hour - 6) * 60 + start.minute - 30;
                            const endOffset = (end.hour - 6) * 60 + end.minute - 30;
                            const duration = endOffset - startOffset;
                            if (duration <= 0) return null;

                            const slotsFromTop = startOffset / 5;
                            const slotsHeight = duration / 5;
                            const topPx = slotsFromTop * 5;
                            const heightPx = slotsHeight * 5;

                            const isBeingDragged = dragPreview?.reservationId === reservation.id;
                            const isBeingUpdated = dragUpdating === reservation.id;
                            const draggable = isDraggableStatus(reservation.status);

                            const wl = weekOverlap.get(reservation.id);
                            const wCol = wl?.col ?? 0;
                            const wTotal = wl?.total ?? 1;

                            const weekColorStyle = getReservationStyle(reservation);
                            const isHighlighted = highlightId === reservation.id;
                            return (
                              <div
                                key={reservation.id}
                                data-reservation-id={reservation.id}
                                className={cn(
                                  "absolute rounded border px-0.5 overflow-hidden z-10 touch-none select-none",
                                  (reservation.status === "cancelled" || reservation.status === "noshow") && "line-through",
                                  draggable ? "cursor-grab" : "cursor-pointer",
                                  isBeingDragged && "opacity-30",
                                  isBeingUpdated && "opacity-50 pointer-events-none",
                                  isHighlighted && "ring-2 ring-primary shadow-lg animate-pulse",
                                )}
                                style={{
                                  ...weekColorStyle,
                                  top: `${topPx + 1}px`,
                                  height: `${heightPx - 2}px`,
                                  left: `calc(${(wCol / wTotal) * 100}% + 1px)`,
                                  width: `calc(${(1 / wTotal) * 100}% - 2px)`,
                                  WebkitTouchCallout: "none",
                                }}
                                onPointerDown={(e) => {
                                  if (draggable) handlePointerDown(e, reservation);
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (justFinishedDragRef.current) return;
                                  router.push(`/reservations/${reservation.id}`);
                                }}
                              >
                                <div className="flex items-center gap-0.5">
                                  {(reservation.is_new_customer != null ? reservation.is_new_customer === 1 : reservation.customer_visit_count === 0) && (
                                    <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#3A76FD" }}>新</span>
                                  )}
                                  {reservation.source === "hotpepper" && (
                                    <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#CB006D" }}>HPB</span>
                                  )}
                                  {reservation.source === "minimo" && (
                                    <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#00A7FF" }}>mini</span>
                                  )}
                                  {reservation.is_nominated === 1 ? (
                                    <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#FD7878" }}>指名</span>
                                  ) : reservation.is_nominated === 0 && (
                                    <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#3A76FD" }}>フリー</span>
                                  )}
                                  {reservation.is_nominated === 0 && (reservation.staff_nickname || reservation.staff_name) && (
                                    <span className="text-[7px] truncate" style={{ color: "#3A76FD" }}>{reservation.staff_nickname || reservation.staff_name}</span>
                                  )}
                                </div>
                                <div className="text-[11px] font-medium break-words leading-tight" style={{ color: "#1a1a1a" }}>
                                  {reservation.customer_name || "顧客"}
                                  {reservation.is_minimo === 1 && (
                                    <span className="ml-0.5 inline-flex items-center rounded-sm px-0.5 text-[7px] leading-[11px] text-white shrink-0" style={{ backgroundColor: "#00A7FF" }}>mini</span>
                                  )}
                                </div>
                                {heightPx >= 7 && (
                                  <div className="text-[10px] truncate" style={{ color: "#1a1a1a" }}>
                                    {start.hour}:{start.minute.toString().padStart(2, "0")}-{end.hour}:{end.minute.toString().padStart(2, "0")}
                                  </div>
                                )}
                              </div>
                            );
                          })}

                          {/* Block overlays (store mode) - positioned via weekOverlap */}
                          {dayBlocks.map((db) => {
                            const topPx = (db.top / 5) * 5;
                            const heightPx = ((db.bottom - db.top) / 5) * 5;
                            const wl = weekOverlap.get(db.blockId);
                            const wCol = wl?.col ?? 0;
                            const wTotal = wl?.total ?? 1;
                            return (
                              <div
                                key={db.blockId}
                                className={`absolute rounded border px-0.5 overflow-hidden z-[4] ${canEditBlock(db.block) ? "cursor-pointer hover:brightness-95" : "pointer-events-none"}`}
                                onClick={canEditBlock(db.block) ? (e) => { e.stopPropagation(); setSelectedBlock(db.block); } : undefined}
                                style={{
                                  top: `${topPx + 1}px`,
                                  height: `${heightPx - 2}px`,
                                  left: `calc(${(wCol / wTotal) * 100}% + 1px)`,
                                  width: `calc(${(1 / wTotal) * 100}% - 2px)`,
                                  backgroundColor: "rgb(229 231 235 / 0.8)",
                                  borderColor: "rgb(209 213 219)",
                                }}
                              >
                                <div className="text-[8px] font-medium truncate leading-tight text-gray-500">
                                  {db.staffMember.nickname || db.staffMember.name}
                                </div>
                                <div className="text-[7px] truncate leading-tight text-gray-400">
                                  {db.block.is_all_day ? "予定あり" : `予定あり ${db.block.start_time}-${db.block.end_time}`}
                                </div>
                              </div>
                            );
                          })}

                          {/* Drag preview ghost (week view) */}
                          {dragPreview && dragPreview.dragDate === dateKey && (() => {
                            const newStartTime = formatDragTime(dragPreview.slotsFromTop);
                            const newEndTime = formatDragTime(dragPreview.slotsFromTop + dragPreview.slotsHeight);
                            const topPx = dragPreview.slotsFromTop * 5;
                            const heightPx = dragPreview.slotsHeight * 5;
                            const invalid = dragPreview.isInvalid;
                            return (
                              <div
                                className={cn(
                                  "absolute left-0.5 right-0.5 rounded border-2 border-dashed px-0.5 z-20 pointer-events-none shadow-lg",
                                  invalid ? "border-red-400 bg-red-100/60" : "border-primary/60 bg-primary/10"
                                )}
                                style={{
                                  top: `${topPx + 1}px`,
                                  height: `${heightPx - 2}px`,
                                }}
                              >
                                <div className={cn("text-[8px] font-bold truncate leading-tight", invalid ? "text-red-500" : "text-primary")}>
                                  {newStartTime}-{newEndTime}
                                </div>
                              </div>
                            );
                          })()}

                          {/* Drag-create ghost (week view) */}
                          {dragCreatePreview && dragCreatePreview.dateKey === dateKey && (() => {
                            const topPx = dragCreatePreview.slotsFromTop * 5;
                            const heightPx = CREATE_SLOTS * 5;
                            const startMin = dragCreatePreview.slotsFromTop * 5 + 6 * 60 + 30;
                            const endMin = startMin + 60;
                            const startStr = `${Math.floor(startMin / 60)}:${(startMin % 60).toString().padStart(2, "0")}`;
                            const endStr = `${Math.floor(endMin / 60)}:${(endMin % 60).toString().padStart(2, "0")}`;
                            return (
                              <div
                                className="absolute left-0.5 right-0.5 rounded border-2 border-dashed border-primary/60 bg-primary/20 z-20 pointer-events-none shadow-lg"
                                style={{
                                  top: `${topPx + 1}px`,
                                  height: `${heightPx - 2}px`,
                                }}
                              >
                                <div className="text-[8px] font-bold truncate leading-tight text-primary flex items-center gap-0.5">
                                  <Plus className="h-2.5 w-2.5" />
                                  {startStr}-{endStr}
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })}
                  </div>
                </div>
            </div>
          </div>
        </Card>
      ) : (
        /* Day View - Multi-staff columns */
        <Card className={cn("overflow-hidden", showAll ? "[--slot-h:7px]" : "[--slot-h:14px]")}>
          <div ref={scrollContainerRef} className="max-h-[calc(100vh-300px)] overflow-auto">
            <div className={cn(showAll && "min-w-max")}>
          {/* Staff header row - hidden in self mode */}
          {showAll && (
            <div className="flex bg-muted/30 border-b sticky top-0 z-20">
              <div className="w-[38px] shrink-0 h-[52px] flex items-center justify-center text-xs font-medium text-muted-foreground sticky left-0 z-30 bg-muted/30">
                <Clock className="h-3.5 w-3.5" />
              </div>
                  {displayStaffList.map((staffMember) => (
                    <div
                      key={staffMember.id}
                      className={cn(
                        "w-[100px] shrink-0 h-[52px] flex flex-col items-center justify-center border-l py-1",
                        staffMember.id === staff?.id && "bg-primary/5"
                      )}
                      title={staffMember.nickname || staffMember.name}
                    >
                      <Avatar className={cn(
                        "h-7 w-7",
                        staffMember.id === staff?.id && "ring-2 ring-primary"
                      )}>
                        {staffMember.avatar_url && <AvatarImage src={getImageUrl(staffMember.avatar_url) || undefined} />}
                        <AvatarFallback className="text-[10px]">{(staffMember.nickname || staffMember.name).charAt(0)}</AvatarFallback>
                      </Avatar>
                      <span className={cn(
                        "text-[9px] mt-0.5 truncate max-w-[96px]",
                        staffMember.id === staff?.id ? "text-primary font-medium" : "text-muted-foreground"
                      )}>{staffMember.nickname || staffMember.name}</span>
                    </div>
                  ))}
            </div>
          )}

          {/* Body */}
            <div className="flex">
              {/* Time labels column */}
              <div className="w-[38px] shrink-0 sticky left-0 z-10 bg-background">
                {timeSlots.map((slot) => (
                  <div
                    key={slot.label}
                    className="h-[var(--slot-h)] relative bg-muted/10"
                  >
                    {slot.minute === 0 && (
                      <span className="absolute -top-[8px] left-0 right-0 text-center text-[10px] font-medium text-muted-foreground leading-none">
                        {slot.label}
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {/* Staff columns */}
                <div className={cn("flex", !showAll && "flex-1")}>
                {displayStaffList.map((staffMember) => {
                  const staffReservations = activeReservations.filter(
                    (r) => r.staff_id === staffMember.id
                  );
                  const memberBlocks = getStaffBlocks(staffMember.id);
                  const memberHasAllDayBlock = memberBlocks.some((b) => b.is_all_day);

                  return (
                    <div
                      key={staffMember.id}
                      data-drag-date={selectedDate}
                      data-drag-staff={staffMember.id}
                      className={cn(
                        "relative",
                        showAll ? "w-[100px] shrink-0 border-l" : "flex-1"
                      )}
                    >
                      {/* Grid slot backgrounds */}
                      {timeSlots.map((slot) => {
                        // Check slot availability for this staff member
                        const slotTime = `${slot.hour.toString().padStart(2, "0")}:${slot.minute.toString().padStart(2, "0")}`;
                        const slotEndMin = slot.hour * 60 + slot.minute + 5;
                        const slotEndTime = `${Math.floor(slotEndMin / 60).toString().padStart(2, "0")}:${(slotEndMin % 60).toString().padStart(2, "0")}`;
                        let slotUnavailable = showAll ? false : memberHasAllDayBlock;
                        if (!slotUnavailable) {
                          for (const block of memberBlocks) {
                            if (block.start_time && block.end_time && block.start_time < slotEndTime && block.end_time > slotTime) {
                              slotUnavailable = true;
                              break;
                            }
                          }
                        }
                        // Check business hours - use per-staff hours if available, otherwise store hours
                        const staffSpecificHours = allStaffBusinessHoursMap.get(staffMember.id);
                        const effectiveSlotHours = staffSpecificHours || storeBusinessHours;
                        if (!slotUnavailable && effectiveSlotHours.length > 0) {
                          const dayHours = findHoursForDate(effectiveSlotHours, selectedDate);
                          if (dayHours?.is_closed) slotUnavailable = true;
                          else if (dayHours?.open_time && dayHours?.close_time) {
                            if (slotTime < dayHours.open_time || slotTime >= dayHours.close_time) slotUnavailable = true;
                          }
                        }
                        return (
                          <div
                            key={slot.label}
                            className={cn(
                              "h-[var(--slot-h)] transition-colors select-none cursor-pointer",
                              slot.minute === 55 ? "border-b border-b-border" : slot.minute % 30 === 25 ? "border-b border-b-border/30" : "",
                              slotUnavailable ? "bg-gray-200/60" : "hover:bg-muted/30 active:bg-muted/50"
                            )}
                            onPointerDown={(e) => {
                              if (slotUnavailable) return;
                              const slotH = showAll ? 7 : 14;
                              handleDragCreateDown(e, selectedDate, slot.hour, slot.minute, slotH, scrollContainerRef, staffMember.id);
                            }}
                            onPointerUp={clearDragCreateTimer}
                            onPointerCancel={clearDragCreateTimer}
                            onContextMenu={(e) => e.preventDefault()}
                          />
                        );
                      })}

                      {/* Block overlays (time-range) */}
                      {memberBlocks.filter((b) => !b.is_all_day && b.start_time && b.end_time).map((block) => {
                        const [bsh, bsm] = block.start_time!.split(":").map(Number);
                        const [beh, bem] = block.end_time!.split(":").map(Number);
                        const startOffset = (bsh - 6) * 60 + bsm - 30;
                        const endOffset = (beh - 6) * 60 + bem - 30;
                        const slotsFromTop = startOffset / 5;
                        const slotsHeight = (endOffset - startOffset) / 5;
                        if (slotsHeight <= 0) return null;
                        return (
                          <div
                            key={`block-${block.id}`}
                            className={`absolute left-0 right-0 bg-gray-200/60 border-l-4 border-gray-400 z-[5] ${canEditBlock(block) ? "cursor-pointer hover:bg-gray-300/60" : "pointer-events-none"}`}
                            onClick={canEditBlock(block) ? (e) => { e.stopPropagation(); setSelectedBlock(block); } : undefined}
                            style={{
                              top: `calc(${slotsFromTop} * var(--slot-h))`,
                              height: `calc(${slotsHeight} * var(--slot-h))`,
                            }}
                          >
                            <div className="px-1 py-0.5 text-[9px] text-gray-600 font-medium truncate">
                              予定あり{block.reason ? `: ${block.reason}` : ""}
                            </div>
                          </div>
                        );
                      })}

                      {/* All-day block overlay */}
                      {memberHasAllDayBlock && (() => {
                        const allDayBlock = memberBlocks.find((b) => b.is_all_day);
                        const dayHours = findHoursForDate(businessHours, selectedDate, { excludeClosed: true });
                        const openTime = dayHours?.open_time || "10:00";
                        const closeTime = dayHours?.close_time || "20:00";
                        const [oh, om] = openTime.split(":").map(Number);
                        const [ch, cm] = closeTime.split(":").map(Number);
                        const startOff = (oh - 6) * 60 + om - 30;
                        const endOff = (ch - 6) * 60 + cm - 30;
                        const sFromTop = startOff / 5;
                        const sHeight = (endOff - startOff) / 5;
                        if (sHeight <= 0) return null;
                        return (
                          <div
                            className={`absolute left-0.5 right-0.5 rounded bg-gray-200/80 border border-gray-300 z-[5] flex flex-col items-center justify-center ${allDayBlock && canEditBlock(allDayBlock) ? "cursor-pointer hover:bg-gray-300/80" : "pointer-events-none"}`}
                            onClick={allDayBlock && canEditBlock(allDayBlock) ? (e) => { e.stopPropagation(); setSelectedBlock(allDayBlock); } : undefined}
                            style={{
                              top: `calc(${sFromTop} * var(--slot-h))`,
                              height: `calc(${sHeight} * var(--slot-h))`,
                            }}
                          >
                            <span className="text-gray-500 font-medium text-[9px] leading-tight">{staffMember.nickname || staffMember.name}</span>
                            <span className="text-gray-500 font-medium text-[9px] leading-tight">予定あり</span>
                          </div>
                        );
                      })()}

                      {/* Closed day overlay - per staff based on their business hours */}
                      {(() => {
                        const staffClosedHours = allStaffBusinessHoursMap.get(staffMember.id);
                        const effHours = staffClosedHours || storeBusinessHours;
                        const dh = findHoursForDate(effHours, selectedDate);
                        const isStaffClosedDay = !!dh?.is_closed;
                        if (!isStaffClosedDay || memberHasAllDayBlock) return null;
                        return (
                          <div className="absolute inset-0 bg-muted/30 pointer-events-none z-[5] flex items-center justify-center">
                            <span className="text-muted-foreground font-medium text-[9px] bg-white/80 px-2 py-0.5 rounded">定休日</span>
                          </div>
                        );
                      })()}

                      {/* Reservation blocks */}
                      {(() => {
                        // Calculate overlap layout for this staff's reservations
                        const dayOverlapItems = staffReservations
                          .filter(r => r.start_at && r.end_at)
                          .map(r => {
                            const s = toJST(r.start_at);
                            const e = toJST(r.end_at);
                            return { id: r.id, top: (s.hour - 6) * 60 + s.minute - 30, bottom: (e.hour - 6) * 60 + e.minute - 30 };
                          })
                          .filter(item => item.bottom > item.top);
                        const dayOverlap = layoutOverlapping(dayOverlapItems);

                        return staffReservations.map((reservation) => {
                        if (!reservation.start_at || !reservation.end_at) return null;
                        const start = toJST(reservation.start_at);
                        const end = toJST(reservation.end_at);
                        const startOffset = (start.hour - 6) * 60 + start.minute - 30;
                        const endOffset = (end.hour - 6) * 60 + end.minute - 30;
                        const duration = endOffset - startOffset;
                        if (duration <= 0) return null;

                        const slotsFromTop = startOffset / 5;
                        const slotsHeight = duration / 5;

                        const startTimeStr = `${start.hour}:${start.minute.toString().padStart(2, "0")}`;
                        const endTimeStr = `${end.hour}:${end.minute.toString().padStart(2, "0")}`;

                        const isBeingDragged = dragPreview?.reservationId === reservation.id;
                        const isBeingUpdated = dragUpdating === reservation.id;
                        const draggable = isDraggableStatus(reservation.status);

                        const ol = dayOverlap.get(reservation.id);
                        const oCol = ol?.col ?? 0;
                        const oTotal = ol?.total ?? 1;

                        const dayColorStyle = getReservationStyle(reservation);
                        const isDayHighlighted = highlightId === reservation.id;
                        return (
                          <div
                            key={reservation.id}
                            data-reservation-id={reservation.id}
                            className={cn(
                              "absolute rounded border px-1 py-0.5 overflow-hidden z-10 touch-none select-none",
                              (reservation.status === "cancelled" || reservation.status === "noshow") && "line-through",
                              draggable ? "cursor-grab" : "cursor-pointer",
                              isBeingDragged && "opacity-30",
                              isBeingUpdated && "opacity-50 pointer-events-none",
                              isDayHighlighted && "ring-2 ring-primary shadow-lg animate-pulse",
                            )}
                            style={{
                              ...dayColorStyle,
                              top: `calc(${slotsFromTop} * var(--slot-h) + 1px)`,
                              height: `calc(${slotsHeight} * var(--slot-h) - 2px)`,
                              left: showAll ? `calc(${(oCol / oTotal) * 100}% + 1px)` : '1px',
                              width: showAll ? `calc(${(1 / oTotal) * 100}% - 2px)` : 'calc(100% - 2px)',
                              WebkitTouchCallout: "none",
                            }}
                            onPointerDown={(e) => {
                              if (draggable) handlePointerDown(e, reservation);
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (justFinishedDragRef.current) return;
                              router.push(`/reservations/${reservation.id}`);
                            }}
                          >
                            <div className="flex items-center gap-0.5">
                              {(reservation.is_new_customer != null ? reservation.is_new_customer === 1 : reservation.customer_visit_count === 0) && (
                                <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#3A76FD" }}>新</span>
                              )}
                              {reservation.source === "hotpepper" && (
                                <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#CB006D" }}>HPB</span>
                              )}
                              {reservation.source === "minimo" && (
                                <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#00A7FF" }}>mini</span>
                              )}
                              {reservation.is_nominated === 1 ? (
                                <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#FD7878" }}>指名</span>
                              ) : reservation.is_nominated === 0 && (
                                <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#3A76FD" }}>フリー</span>
                              )}
                              {reservation.is_nominated === 0 && (reservation.staff_nickname || reservation.staff_name) && (
                                <span className="text-[7px] truncate" style={{ color: "#3A76FD" }}>{reservation.staff_nickname || reservation.staff_name}</span>
                              )}
                            </div>
                            <div className="text-[11px] font-medium break-words leading-tight" style={{ color: "#1a1a1a" }}>
                              {reservation.customer_name || "顧客未設定"}
                              {reservation.is_minimo === 1 && (
                                <span className="ml-0.5 inline-flex items-center rounded-sm px-0.5 text-[7px] leading-[11px] text-white shrink-0" style={{ backgroundColor: "#00A7FF" }}>mini</span>
                              )}
                            </div>
                            <div className="text-[10px] truncate" style={{ color: "#1a1a1a" }}>
                              {startTimeStr}-{endTimeStr}
                            </div>
                            {slotsHeight >= 12 && (
                              <div className="text-[10px] truncate" style={{ color: "#444" }}>
                                {reservation.menus && reservation.menus.length > 1
                                  ? `${reservation.menus[0].name} +${reservation.menus.length - 1}`
                                  : reservation.menus?.[0]?.name || reservation.menu_name}
                              </div>
                            )}
                          </div>
                        );
                      });
                      })()}

                      {/* Drag preview ghost */}
                      {dragPreview && staffReservations.some(r => r.id === dragPreview.reservationId) && (() => {
                        const draggedRes = staffReservations.find(r => r.id === dragPreview.reservationId)!;
                        const newStartTime = formatDragTime(dragPreview.slotsFromTop);
                        const newEndTime = formatDragTime(dragPreview.slotsFromTop + dragPreview.slotsHeight);
                        const invalid = dragPreview.isInvalid;
                        return (
                          <div
                            className={cn(
                              "absolute left-0.5 right-0.5 rounded border-2 border-dashed px-1 py-0.5 z-20 pointer-events-none shadow-lg",
                              invalid ? "border-red-400 bg-red-100/60" : "border-primary/60 bg-primary/10",
                            )}
                            style={{
                              top: `calc(${dragPreview.slotsFromTop} * var(--slot-h) + 1px)`,
                              height: `calc(${dragPreview.slotsHeight} * var(--slot-h) - 2px)`,
                            }}
                          >
                            <div className={cn("text-[9px] font-bold truncate", invalid ? "text-red-500" : "text-primary")}>
                              {newStartTime}-{newEndTime}
                            </div>
                            <div className={cn("text-[9px] truncate", invalid ? "text-red-400" : "text-primary/80")}>
                              {draggedRes.customer_name || "顧客未設定"}
                            </div>
                          </div>
                        );
                      })()}

                      {/* Drag-create ghost (day view) */}
                      {dragCreatePreview && dragCreatePreview.staffId === staffMember.id && dragCreatePreview.dateKey === selectedDate && (() => {
                        const slotH = showAll ? 7 : 14;
                        const topPx = dragCreatePreview.slotsFromTop * slotH;
                        const heightPx = CREATE_SLOTS * slotH;
                        const startMin = dragCreatePreview.slotsFromTop * 5 + 6 * 60 + 30;
                        const endMin = startMin + 60;
                        const startStr = `${Math.floor(startMin / 60)}:${(startMin % 60).toString().padStart(2, "0")}`;
                        const endStr = `${Math.floor(endMin / 60)}:${(endMin % 60).toString().padStart(2, "0")}`;
                        return (
                          <div
                            className="absolute left-0.5 right-0.5 rounded border-2 border-dashed border-primary/60 bg-primary/20 z-20 pointer-events-none shadow-lg"
                            style={{
                              top: `${topPx + 1}px`,
                              height: `${heightPx - 2}px`,
                            }}
                          >
                            <div className="text-[9px] font-bold truncate text-primary flex items-center gap-0.5">
                              <Plus className="h-2.5 w-2.5" />
                              {startStr}-{endStr}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}
      </div>

      {/* Summary */}
      {!isLoading && (
        <p className="text-center text-xs text-muted-foreground">
          {activeReservations.length > 0 && `${activeReservations.length}件の予約`}
          {activeReservations.length > 0 && myBlocks.length > 0 && " / "}
          {myBlocks.length > 0 && `${myBlocks.length}件のブロック`}
          {activeReservations.length === 0 && myBlocks.length === 0 && viewMode === "day" && "長押しで予約を追加"}
        </p>
      )}

      {/* Block Create Dialog */}
      <Dialog open={showBlockDialog} onOpenChange={setShowBlockDialog}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingBlockId ? "個人の予定を編集" : "個人の予定を追加"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>日付</Label>
              <Input type="date" value={blockDate} onChange={(e) => setBlockDate(e.target.value)} />
            </div>
            <div className="flex items-center gap-3">
              <input type="checkbox" id="block-allday" checked={blockIsAllDay} onChange={(e) => setBlockIsAllDay(e.target.checked)} className="h-4 w-4 rounded border-gray-300" />
              <Label htmlFor="block-allday">終日</Label>
            </div>
            {!blockIsAllDay && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>開始時間</Label>
                  <select value={blockStartTime} onChange={(e) => setBlockStartTime(e.target.value)} className="flex items-center h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent px-3 py-0 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm">
                    {Array.from({ length: 24 * 12 }, (_, i) => { const h = String(Math.floor(i / 12)).padStart(2, "0"); const m = String((i % 12) * 5).padStart(2, "0"); return <option key={`${h}:${m}`} value={`${h}:${m}`}>{`${h}:${m}`}</option>; })}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>終了時間</Label>
                  <select value={blockEndTime} onChange={(e) => setBlockEndTime(e.target.value)} className="flex items-center h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent px-3 py-0 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm">
                    {Array.from({ length: 24 * 12 }, (_, i) => { const h = String(Math.floor(i / 12)).padStart(2, "0"); const m = String((i % 12) * 5).padStart(2, "0"); return <option key={`${h}:${m}`} value={`${h}:${m}`}>{`${h}:${m}`}</option>; })}
                  </select>
                </div>
              </div>
            )}
            <div className="space-y-2">
              <Label>理由（任意）</Label>
              <Input value={blockReason} onChange={(e) => setBlockReason(e.target.value)} placeholder="例: 通院、家庭の用事" />
            </div>
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button onClick={handleSaveBlock} disabled={actionLoading || !blockDate} className="w-full sm:w-auto">{editingBlockId ? "保存" : "追加"}</Button>
            <Button variant="outline" onClick={() => setShowBlockDialog(false)} disabled={actionLoading} className="w-full sm:w-auto">キャンセル</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Block Detail Dialog */}
      <Dialog open={!!selectedBlock} onOpenChange={(open) => { if (!open) setSelectedBlock(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ブロック詳細</DialogTitle>
          </DialogHeader>
          {selectedBlock && (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Ban className="h-4 w-4 text-destructive" />
                  <span className="font-medium">
                    {selectedBlock.is_all_day ? "終日ブロック" : `${selectedBlock.start_time} - ${selectedBlock.end_time}`}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">日付: {formatDate(selectedBlock.date + "T00:00:00", "date")}</p>
                {selectedBlock.reason && <p className="text-sm text-muted-foreground">理由: {selectedBlock.reason}</p>}
                {selectedBlock.store_id === null && <p className="text-xs text-muted-foreground">全店舗に適用</p>}
              </div>
              <DialogFooter className="flex-col gap-2 sm:flex-row">
                <Button variant="outline" onClick={() => { setSelectedBlock(null); openBlockDialog(selectedBlock); }} disabled={actionLoading}>
                  <Pencil className="mr-1 h-4 w-4" />編集
                </Button>
                <Button variant="destructive" onClick={() => handleDeleteBlock(selectedBlock.id)} disabled={actionLoading}>
                  <Trash2 className="mr-1 h-4 w-4" />削除
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

    </div>
  );
}

export default function ReservationsPage() {
  return (
    <Suspense fallback={<div className="py-12 text-center text-muted-foreground">読み込み中...</div>}>
      <ReservationsContent />
    </Suspense>
  );
}
