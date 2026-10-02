"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSwipeNavigation } from "@/hooks/use-swipe-navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { ChevronLeft, ChevronRight, Plus, X, User, Clock, RotateCcw, Search } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { reservations, staff as staffApi, menus as menusApi, stores as storesApi, type Reservation, type Staff, type Menu, type BusinessHours, type StaffBusinessHours } from "@/lib/api";
import { useStore } from "@/contexts/store-context";
import { formatDate, formatPrice, cn, getImageUrl } from "@/lib/utils";

type ViewMode = "day" | "week" | "month";

// Greedy side-by-side column layout for overlapping items (same as staff app week view).
function layoutOverlapping(items: { id: string; top: number; bottom: number }[]) {
  if (items.length === 0) return new Map<string, { col: number; total: number }>();
  const sorted = [...items].sort((a, b) => a.top - b.top || (b.bottom - b.top) - (a.bottom - a.top));
  const colEnds: number[] = [];
  const colAssign = new Map<string, number>();
  for (const item of sorted) {
    let placed = -1;
    for (let c = 0; c < colEnds.length; c++) {
      if (item.top >= colEnds[c]) { placed = c; colEnds[c] = item.bottom; break; }
    }
    if (placed === -1) { placed = colEnds.length; colEnds.push(item.bottom); }
    colAssign.set(item.id, placed);
  }
  const par = new Map<string, string>();
  for (const item of sorted) par.set(item.id, item.id);
  const find = (x: string): string => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x)!)!); x = par.get(x)!; } return x; };
  const unite = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) par.set(ra, rb); };
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].top < sorted[i].bottom) unite(sorted[i].id, sorted[j].id);
    }
  }
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

export default function ReservationsPage() {
  const router = useRouter();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [dayViewAxis, setDayViewAxis] = useState<"staff-row" | "time-row">("time-row"); // staff-row: スタッフが行, time-row: 時間が行
  const [reservationList, setReservationList] = useState<Reservation[]>([]);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [selectedStaff, setSelectedStaff] = useState<string>("all"); // Default to show all staff
  const [loading, setLoading] = useState(true);
  const { currentStore } = useStore();

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [searchResults, setSearchResults] = useState<Reservation[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cancelled reservations panel
  const [showCancelled, setShowCancelled] = useState(false);
  const [menuList, setMenuList] = useState<Menu[]>([]);
  const [categoryColors, setCategoryColors] = useState<Record<string, string>>({});
  const [isDragging, setIsDragging] = useState(false);
  const [businessHours, setBusinessHours] = useState<BusinessHours[]>([]);
  const [staffBusinessHoursMap, setStaffBusinessHoursMap] = useState<Map<string, StaffBusinessHours[]>>(new Map());

  // Week view drag-create state
  // Week drag-create: ghost snaps to cells, 1h tall, 5-min increments
  const WEEK_CREATE_SLOTS = 12; // 1 hour = 12 × 5-min slots
  const [weekDragPreview, setWeekDragPreview] = useState<{
    targetDate: Date | null;
    targetHour: number;
    targetMinute: number;
    cellTop: number;
    colLeft: number;
    colWidth: number;
    cellHeight: number;
  } | null>(null);
  const weekDragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Format date as YYYY-MM-DD in local timezone
  const formatDateLocal = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  // Calculate date range based on view mode
  const dateRange = useMemo(() => {
    const start = new Date(currentDate);
    const end = new Date(currentDate);

    if (viewMode === "day") {
      // Single day
    } else if (viewMode === "week") {
      // Start from Monday
      const day = start.getDay();
      const diff = day === 0 ? -6 : 1 - day;
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
  }, [currentDate, viewMode]);


  useEffect(() => {
    const fetchStaffAndHours = async () => {
      if (!currentStore) return;
      try {
        const [staffRes, storeRes] = await Promise.all([
          staffApi.list(currentStore.id),
          storesApi.get(currentStore.id),
        ]);
        setStaffList(staffRes.staff);
        setBusinessHours(storeRes.business_hours);

        // Fetch per-staff business hours
        const hoursMap = new Map<string, StaffBusinessHours[]>();
        await Promise.all(
          staffRes.staff.map(async (s: Staff) => {
            try {
              const res = await staffApi.getBusinessHours(s.id, currentStore.id);
              if (res.business_hours.length > 0) {
                hoursMap.set(s.id, res.business_hours);
              }
            } catch {
              // ignore
            }
          })
        );
        setStaffBusinessHoursMap(hoursMap);
      } catch (error) {
        console.error("Failed to fetch staff or business hours:", error);
      }
    };
    fetchStaffAndHours();
  }, [currentStore?.id]);

  // Fetch menus for category colors
  useEffect(() => {
    menusApi.list(undefined, true).then((res) => {
      setMenuList(res.menus);
      setCategoryColors(res.categoryColors || {});
    }).catch(console.error);
  }, []);

  useEffect(() => {
    const fetchReservations = async () => {
      if (!currentStore) return;
      setLoading(true);
      try {
        const params: { store_id: string; start_date: string; end_date: string; staff_id?: string } = {
          store_id: currentStore.id,
          start_date: dateRange.start,
          end_date: dateRange.end,
        };
        if (selectedStaff !== "all") {
          params.staff_id = selectedStaff;
        }
        const { reservations: data } = await reservations.list(params);
        setReservationList(data);
      } catch (error) {
        console.error("Failed to fetch reservations:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchReservations();
  }, [dateRange.start, dateRange.end, selectedStaff, currentStore?.id]);

  // Search with debounce
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!searchInput.trim()) {
      setSearchQuery("");
      setSearchResults([]);
      return;
    }
    searchTimerRef.current = setTimeout(() => {
      setSearchQuery(searchInput.trim());
    }, 400);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [searchInput]);

  useEffect(() => {
    if (!searchQuery || !currentStore) {
      setSearchResults([]);
      return;
    }
    const doSearch = async () => {
      setSearchLoading(true);
      try {
        const { reservations: data } = await reservations.list({
          store_id: currentStore.id,
          search: searchQuery,
          limit: 50,
        });
        setSearchResults(data.sort((a, b) => new Date(b.start_at).getTime() - new Date(a.start_at).getTime()));
      } catch (error) {
        console.error("Search failed:", error);
      } finally {
        setSearchLoading(false);
      }
    };
    doSearch();
  }, [searchQuery, currentStore]);

  const handleNavigate = (direction: number) => {
    const newDate = new Date(currentDate);
    if (viewMode === "day") {
      newDate.setDate(newDate.getDate() + direction);
    } else if (viewMode === "week") {
      newDate.setDate(newDate.getDate() + direction * 7);
    } else if (viewMode === "month") {
      newDate.setMonth(newDate.getMonth() + direction);
    }
    setCurrentDate(newDate);
  };

  const handleToday = () => {
    setCurrentDate(new Date());
  };

  const swipeHandlers = useSwipeNavigation(handleNavigate);

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

  // Navigate to new reservation page with date/time pre-filled
  const openNewReservationDialog = useCallback((date: Date, hour?: number, minute?: number) => {
    const dateStr = date.toISOString().split("T")[0];
    const time = hour !== undefined
      ? `${hour.toString().padStart(2, "0")}:${(minute ?? 0).toString().padStart(2, "0")}`
      : undefined;
    const params = new URLSearchParams();
    params.set("date", dateStr);
    if (time) params.set("time", time);
    router.push(`/reservations/new?${params}`);
  }, [router]);

  // Week view drag-create handlers
  const clearWeekDragTimer = useCallback(() => {
    if (weekDragTimerRef.current) {
      clearTimeout(weekDragTimerRef.current);
      weekDragTimerRef.current = null;
    }
  }, []);

  const handleWeekPointerDown = useCallback((e: React.PointerEvent, day: Date, hour: number, minute: number) => {
    if (e.button !== 0) return;
    const target = e.currentTarget as HTMLElement;
    clearWeekDragTimer();
    weekDragTimerRef.current = setTimeout(() => {
      weekDragTimerRef.current = null;
      window.getSelection()?.removeAllRanges();
      const rect = target.getBoundingClientRect();
      setWeekDragPreview({
        targetDate: day,
        targetHour: hour,
        targetMinute: minute,
        cellTop: rect.top,
        colLeft: rect.left,
        colWidth: rect.width,
        cellHeight: rect.height,
      });
      if (navigator.vibrate) navigator.vibrate(50);
    }, 500);
  }, [clearWeekDragTimer]);

  useEffect(() => {
    if (!weekDragPreview) return;

    const handleMove = (e: PointerEvent) => {
      const ghostEl = document.getElementById("week-drag-ghost");
      if (ghostEl) ghostEl.style.visibility = "hidden";
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (ghostEl) ghostEl.style.visibility = "";

      if (el instanceof HTMLElement) {
        const cell = el.closest("[data-week-cell]") as HTMLElement | null;
        if (cell) {
          const dateStr = cell.dataset.weekDate;
          const h = parseInt(cell.dataset.slotHour || "0", 10);
          const m = parseInt(cell.dataset.slotMinute || "0", 10);
          if (dateStr) {
            const [y, mo, d] = dateStr.split("-").map(Number);
            const cellRect = cell.getBoundingClientRect();
            setWeekDragPreview({
              targetDate: new Date(y, mo - 1, d),
              targetHour: h,
              targetMinute: m,
              cellTop: cellRect.top,
              colLeft: cellRect.left,
              colWidth: cellRect.width,
              cellHeight: cellRect.height,
            });
          }
        }
      }
    };

    const handleUp = () => {
      const p = weekDragPreview;
      setWeekDragPreview(null);
      if (p?.targetDate) {
        // Start time = top of ghost = finger position - 55 minutes
        const startMinTotal = p.targetHour * 60 + p.targetMinute - 55;
        const startH = Math.max(0, Math.floor(startMinTotal / 60));
        const startM = Math.max(0, startMinTotal % 60);
        openNewReservationDialog(p.targetDate, startH, startM);
      }
    };

    const handleCancel = () => {
      setWeekDragPreview(null);
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
  }, [weekDragPreview]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => { clearWeekDragTimer(); };
  }, [clearWeekDragTimer]);

  // Handle drag and drop to move reservation to another staff and/or time
  const handleMoveReservation = async (
    reservationId: string,
    newStaffId: string,
    newStartHour?: number,
    newStartMinute?: number
  ) => {
    try {
      const updateData: Partial<Reservation> = { staff_id: newStaffId };

      // If time is provided, calculate new start_at and end_at
      if (newStartHour !== undefined && newStartMinute !== undefined) {
        // Find the original reservation to get duration
        const original = reservationList.find((r) => r.id === reservationId);
        if (original) {
          const originalStart = new Date(original.start_at);
          const originalEnd = new Date(original.end_at);
          const durationMs = originalEnd.getTime() - originalStart.getTime();

          // Create new start time on current date
          const newStart = new Date(currentDate);
          newStart.setHours(newStartHour, newStartMinute, 0, 0);

          // Calculate new end time
          const newEnd = new Date(newStart.getTime() + durationMs);

          // Format as ISO string for API
          updateData.start_at = newStart.toISOString();
          updateData.end_at = newEnd.toISOString();
        }
      }

      await reservations.update(reservationId, updateData);
      // Refresh reservations list
      if (!currentStore?.id) return;
      const params: { store_id: string; start_date: string; end_date: string; staff_id?: string } = {
        store_id: currentStore.id,
        start_date: dateRange.start,
        end_date: dateRange.end,
      };
      if (selectedStaff !== "all") {
        params.staff_id = selectedStaff;
      }
      const { reservations: data } = await reservations.list(params);
      setReservationList(data);
    } catch (error) {
      console.error("Failed to move reservation:", error);
      alert("予約の移動に失敗しました");
    }
  };

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, reservation: Reservation) => {
    e.dataTransfer.setData("reservationId", reservation.id);
    e.dataTransfer.setData("currentStaffId", reservation.staff_id);
    e.dataTransfer.effectAllowed = "move";
    // Make dragged element semi-transparent
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "0.5";
    }
    setIsDragging(true);
  };

  const handleDragEnd = (e: React.DragEvent) => {
    // Restore opacity
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "1";
    }
    setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.classList.add("bg-primary/20");
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.classList.remove("bg-primary/20");
    }
  };

  // Drop handler with time calculation
  const handleDropWithTime = async (
    e: React.DragEvent,
    targetStaffId: string,
    slotHour: number,
    slotMinute: number
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.classList.remove("bg-primary/20");
    }
    const reservationId = e.dataTransfer.getData("reservationId");

    if (reservationId) {
      await handleMoveReservation(reservationId, targetStaffId, slotHour, slotMinute);
    }
  };

  // Simple drop handler (staff change only)
  const handleDrop = async (e: React.DragEvent, targetStaffId: string) => {
    e.preventDefault();
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.classList.remove("bg-primary/20");
    }
    const reservationId = e.dataTransfer.getData("reservationId");
    const currentStaffId = e.dataTransfer.getData("currentStaffId");

    if (reservationId && currentStaffId !== targetStaffId) {
      await handleMoveReservation(reservationId, targetStaffId);
    }
  };

  const getStatusColor = (status: Reservation["status"]) => {
    switch (status) {
      case "pending":
        return "bg-yellow-100 border-yellow-300 text-yellow-800";
      case "confirmed":
        return "bg-green-100 border-green-300 text-green-800";
      case "completed":
        return "bg-gray-100 border-gray-300 text-gray-600";
      case "cancelled":
      case "noshow":
        return "bg-red-100 border-red-300 text-red-800 line-through";
      default:
        return "bg-primary/10 border-primary/30";
    }
  };

  // Get category color for a reservation based on its menu
  const getReservationCategoryColor = (reservation: Reservation) => {
    // Find the menu to get its category
    const menu = menuList.find((m) => m.id === reservation.menu_id);
    if (menu && menu.category && categoryColors[menu.category]) {
      return categoryColors[menu.category];
    }
    return null;
  };

  // Get reservation style with category color
  const getReservationStyle = (reservation: Reservation) => {
    const categoryColor = getReservationCategoryColor(reservation);
    if (categoryColor && reservation.status !== "cancelled" && reservation.status !== "noshow") {
      return {
        backgroundColor: categoryColor + "20", // 20% opacity
        borderColor: categoryColor,
        borderLeftWidth: "4px",
      };
    }
    return {};
  };

  // Get header text based on view mode
  const getHeaderText = () => {
    if (viewMode === "day") {
      return formatDate(currentDate.toISOString(), "date");
    } else if (viewMode === "week") {
      const start = new Date(dateRange.start);
      const end = new Date(dateRange.end);
      return `${start.getMonth() + 1}/${start.getDate()} - ${end.getMonth() + 1}/${end.getDate()}`;
    } else {
      return `${currentDate.getFullYear()}年${currentDate.getMonth() + 1}月`;
    }
  };

  // Extract date from start_at (handles both "2025-12-28 09:00:00" and "2025-12-28T09:00:00.000Z" formats)
  const extractDate = (startAt: string) => {
    // Parse the date and format in local timezone
    const date = new Date(startAt);
    return formatDateLocal(date);
  };

  // Active reservations (exclude cancelled/noshow for schedule display)
  const activeReservations = useMemo(() => {
    return reservationList.filter((r) => r.status !== "cancelled" && r.status !== "noshow");
  }, [reservationList]);

  // Cancelled reservations
  const cancelledReservations = useMemo(() => {
    return reservationList.filter((r) => r.status === "cancelled" || r.status === "noshow");
  }, [reservationList]);

  // Group reservations by date (active only for schedule display)
  const reservationsByDate = useMemo(() => {
    const grouped: Record<string, Reservation[]> = {};
    activeReservations.forEach((r) => {
      const date = extractDate(r.start_at);
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push(r);
    });
    // Sort by time within each date
    Object.keys(grouped).forEach((date) => {
      grouped[date].sort((a, b) => a.start_at.localeCompare(b.start_at));
    });
    return grouped;
  }, [activeReservations]);

  // Generate calendar days for month view
  const calendarDays = useMemo(() => {
    if (viewMode !== "month") return [];

    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDay = firstDay.getDay();
    const daysInMonth = lastDay.getDate();

    const days: { date: Date; isCurrentMonth: boolean }[] = [];

    // Previous month days
    const prevMonthLastDay = new Date(year, month, 0).getDate();
    for (let i = startDay - 1; i >= 0; i--) {
      days.push({
        date: new Date(year, month - 1, prevMonthLastDay - i),
        isCurrentMonth: false,
      });
    }

    // Current month days
    for (let i = 1; i <= daysInMonth; i++) {
      days.push({
        date: new Date(year, month, i),
        isCurrentMonth: true,
      });
    }

    // Next month days
    const remainingDays = 42 - days.length; // 6 weeks
    for (let i = 1; i <= remainingDays; i++) {
      days.push({
        date: new Date(year, month + 1, i),
        isCurrentMonth: false,
      });
    }

    return days;
  }, [currentDate, viewMode]);

  // Generate week days
  const weekDays = useMemo(() => {
    if (viewMode !== "week") return [];
    const days: Date[] = [];
    const start = new Date(dateRange.start);
    for (let i = 0; i < 7; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      days.push(day);
    }
    return days;
  }, [dateRange.start, viewMode]);

  // Time slots for day/week view (6:30 - 22:45 in 5-minute increments)
  const timeSlots = useMemo(() => {
    const slots: { hour: number; minute: number; label: string }[] = [];
    for (let hour = 6; hour <= 22; hour++) {
      for (let minute = 0; minute < 60; minute += 5) {
        if (hour === 6 && minute < 30) continue; // Start at 6:30
        if (hour === 22 && minute > 45) break; // Stop at 22:45
        slots.push({
          hour,
          minute,
          label: `${hour}:${minute.toString().padStart(2, "0")}`,
        });
      }
    }
    return slots;
  }, []);

  const isToday = (date: Date) => {
    const today = new Date();
    return (
      date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear()
    );
  };

  const formatDateKey = (date: Date) => {
    return formatDateLocal(date);
  };

  // Check if a time slot is outside business hours for a given date
  const isOutsideBusinessHours = useCallback((date: Date, hour: number, minute: number) => {
    if (businessHours.length === 0) return false;
    const dayOfWeek = date.getDay();
    const dayHours = businessHours.find((h) => h.day_of_week === dayOfWeek);
    if (!dayHours) return false;
    if (dayHours.is_closed) return true;
    if (dayHours.open_time && dayHours.close_time) {
      const slotTime = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
      return slotTime < dayHours.open_time || slotTime >= dayHours.close_time;
    }
    return false;
  }, [businessHours]);

  // Check if a staff member is off on a given date (all day) or outside their working hours
  const isStaffOff = useCallback((staffId: string, date: Date, hour?: number, minute?: number) => {
    const staffHours = staffBusinessHoursMap.get(staffId);
    if (!staffHours) return false; // No per-staff hours configured, use store hours
    const dayOfWeek = date.getDay();
    const dayHours = staffHours.find((h) => h.day_of_week === dayOfWeek);
    if (!dayHours) return false;
    if (dayHours.is_closed) return true;
    if (hour !== undefined && minute !== undefined && dayHours.open_time && dayHours.close_time) {
      const slotTime = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
      return slotTime < dayHours.open_time || slotTime >= dayHours.close_time;
    }
    return false;
  }, [staffBusinessHoursMap]);

  // Check if a staff member has the whole day off
  const isStaffDayOff = useCallback((staffId: string, date: Date) => {
    const staffHours = staffBusinessHoursMap.get(staffId);
    if (!staffHours) return false;
    const dayOfWeek = date.getDay();
    const dayHours = staffHours.find((h) => h.day_of_week === dayOfWeek);
    if (!dayHours) return false;
    return !!dayHours.is_closed;
  }, [staffBusinessHoursMap]);

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl md:text-2xl font-bold">予約管理</h1>
        <Button size="sm" onClick={() => openNewReservationDialog(currentDate)}>
          <Plus className="mr-1 md:mr-2 h-4 w-4" />
          <span className="hidden sm:inline">新規予約</span>
          <span className="sm:hidden">追加</span>
        </Button>
      </div>

      {/* Controls */}
      <Card>
        <CardContent className="py-3 md:py-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            {/* Navigation */}
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => handleNavigate(-1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={handleToday}>
                今日
              </Button>
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => handleNavigate(1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <span className="ml-2 font-medium text-sm md:text-base">{getHeaderText()}</span>
            </div>

            {/* View Mode & Staff Filter */}
            <div className="flex items-center gap-2">
              <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)}>
                <TabsList className="h-8">
                  <TabsTrigger value="day" className="text-xs px-2 md:px-3">日</TabsTrigger>
                  <TabsTrigger value="week" className="text-xs px-2 md:px-3">週</TabsTrigger>
                  <TabsTrigger value="month" className="text-xs px-2 md:px-3">月</TabsTrigger>
                </TabsList>
              </Tabs>
              <Select value={selectedStaff} onValueChange={setSelectedStaff}>
                <SelectTrigger className="w-[100px] md:w-[150px] h-8">
                  <SelectValue placeholder="スタッフ" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全員</SelectItem>
                  {staffList.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {/* Search bar */}
          <div className="relative mt-3">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="名前・電話番号で検索..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9 h-8 text-sm"
            />
            {searchInput && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
                onClick={() => { setSearchInput(""); setSearchQuery(""); setSearchResults([]); }}
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Search Results */}
      {searchQuery && (
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-sm font-medium mb-3">
              検索結果: 「{searchQuery}」{searchLoading ? " 検索中..." : ` ${searchResults.length}件`}
            </div>
            {!searchLoading && searchResults.length === 0 && (
              <div className="py-4 text-center text-muted-foreground text-sm">該当する予約が見つかりません</div>
            )}
            <div className="space-y-2">
              {searchResults.map((r) => (
                <div
                  key={r.id}
                  className={cn(
                    "flex items-center gap-3 p-2 rounded-md border cursor-pointer hover:bg-muted/50 transition-colors",
                    r.status === "cancelled" || r.status === "noshow" ? "opacity-60" : ""
                  )}
                  onClick={() => router.push(`/reservations/${r.id}`)}
                >
                  <div className="text-xs text-muted-foreground w-[90px] shrink-0">
                    <div>{formatDate(r.start_at, "date")}</div>
                    <div>{formatDate(r.start_at, "time")}~{formatDate(r.end_at, "time")}</div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate flex items-center gap-1">
                      {r.customer_name}
                      {r.customer_phone && (
                        <span className="text-xs text-muted-foreground font-normal">{r.customer_phone}</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{r.menu_name} / {r.staff_name}</div>
                  </div>
                  <div className="shrink-0 flex items-center gap-1">
                    {r.source === "hotpepper" && (
                      <span className="inline-flex items-center px-1 text-[9px] leading-[14px] text-white rounded-sm" style={{ backgroundColor: "#CB006D" }}>HPB</span>
                    )}
                    {r.source === "minimo" && (
                      <span className="inline-flex items-center px-1 text-[9px] leading-[14px] text-white rounded-sm" style={{ backgroundColor: "#00A7FF" }}>mini</span>
                    )}
                    {r.has_consent && (
                      <span className="inline-flex items-center px-1 text-[9px] leading-[14px] text-white rounded-sm " style={{ backgroundColor: "#F36C21" }}>同意済</span>
                    )}
                    {r.status === "cancelled" && <Badge variant="destructive" className="text-[10px]">キャンセル</Badge>}
                    {r.status === "noshow" && <Badge variant="destructive" className="text-[10px]">無断</Badge>}
                    {r.status === "confirmed" && <Badge className="text-[10px] bg-green-600">確定</Badge>}
                    {r.status === "pending" && <Badge className="text-[10px] bg-yellow-500">確認待ち</Badge>}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Calendar View */}
      <Card className={searchQuery ? "hidden" : ""}>
        <CardContent className="p-2 md:p-4" {...(viewMode !== "week" ? swipeHandlers : {})}>
          {loading ? (
            <div className="py-8 text-center text-muted-foreground">読み込み中...</div>
          ) : viewMode === "month" ? (
            // Month View
            <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden">
              {/* Header */}
              {["日", "月", "火", "水", "木", "金", "土"].map((day, i) => (
                <div
                  key={day}
                  className={cn(
                    "bg-muted p-2 text-center text-xs font-medium",
                    i === 0 && "text-red-500",
                    i === 6 && "text-blue-500"
                  )}
                >
                  {day}
                </div>
              ))}
              {/* Days */}
              {calendarDays.map(({ date, isCurrentMonth }, index) => {
                const dateKey = formatDateKey(date);
                const dayReservations = reservationsByDate[dateKey] || [];
                const dayOfWeek = date.getDay();
                // Check if store is closed on this day of week
                const storeDayHours = businessHours.find((h) => h.day_of_week === dayOfWeek);
                const isStoreClosed = storeDayHours?.is_closed === 1;
                // Check if selected staff is off on this day
                const isSelectedStaffOff = selectedStaff !== "all" && isStaffDayOff(selectedStaff, date);

                return (
                  <div
                    key={index}
                    className={cn(
                      "bg-card min-h-[80px] md:min-h-[100px] p-1 md:p-2 cursor-pointer hover:bg-muted/50",
                      !isCurrentMonth && "bg-muted/50",
                      isToday(date) && "bg-primary/5",
                      (isStoreClosed || isSelectedStaffOff) && "bg-gray-200/60"
                    )}
                    onClick={() => {
                      setCurrentDate(date);
                      setViewMode("day");
                    }}
                  >
                    <div
                      className={cn(
                        "text-xs md:text-sm font-medium mb-1",
                        !isCurrentMonth && "text-muted-foreground",
                        dayOfWeek === 0 && "text-red-500",
                        dayOfWeek === 6 && "text-blue-500",
                        isToday(date) && "bg-primary text-white rounded-full w-6 h-6 flex items-center justify-center"
                      )}
                    >
                      {date.getDate()}
                    </div>
                    <div className="space-y-0.5">
                      {dayReservations.slice(0, 3).map((r) => (
                        <div
                          key={r.id}
                          className={cn(
                            "text-[10px] md:text-xs truncate px-1 rounded border",
                            getStatusColor(r.status)
                          )}
                          style={getReservationStyle(r)}
                          title={`${r.customer_name} - ${r.staff_name}`}
                        >
                          {formatDate(r.start_at, "time")} {r.staff_name}
                          {(r.is_new_customer != null ? r.is_new_customer === 1 : r.customer_visit_count === 0) && (
                            <span className="inline-flex items-center ml-0.5 px-0.5 text-[7px] leading-[11px] text-white rounded-sm shrink-0" style={{ backgroundColor: "#3A76FD" }}>新規</span>
                          )}
                          {r.source === "hotpepper" && (
                            <span className="inline-flex items-center ml-0.5 px-0.5 text-[7px] leading-[11px] text-white rounded-sm shrink-0" style={{ backgroundColor: "#CB006D" }}>HPB</span>
                          )}
                          {r.source === "minimo" && (
                            <span className="inline-flex items-center ml-0.5 px-0.5 text-[7px] leading-[11px] text-white rounded-sm shrink-0" style={{ backgroundColor: "#00A7FF" }}>minimo</span>
                          )}
                          {r.has_consent && (
                            <span className="inline-flex items-center ml-0.5 px-0.5 text-[7px] leading-[11px] text-white rounded-sm shrink-0 " style={{ backgroundColor: "#F36C21" }}>同意済</span>
                          )}
                        </div>
                      ))}
                      {dayReservations.length > 3 && (
                        <div className="text-[10px] text-muted-foreground px-1">
                          +{dayReservations.length - 3}件
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : viewMode === "week" ? (
            // Week View
            <div className="overflow-x-auto">
              <div className="min-w-[1000px]">
                {/* Header */}
                <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b">
                  <div className="p-2 text-center text-xs font-medium text-muted-foreground">
                    時間
                  </div>
                  {weekDays.map((day, i) => (
                    <div
                      key={i}
                      className={cn(
                        "p-2 text-center border-l cursor-pointer hover:bg-muted/50",
                        isToday(day) && "bg-primary/5"
                      )}
                      onClick={() => {
                        setCurrentDate(day);
                        setViewMode("day");
                      }}
                    >
                      <div className={cn(
                        "text-xs text-muted-foreground",
                        day.getDay() === 0 && "text-red-500",
                        day.getDay() === 6 && "text-blue-500"
                      )}>
                        {["日", "月", "火", "水", "木", "金", "土"][day.getDay()]}
                      </div>
                      <div className={cn(
                        "text-sm font-medium",
                        isToday(day) && "bg-primary text-white rounded-full w-6 h-6 mx-auto flex items-center justify-center"
                      )}>
                        {day.getDate()}
                      </div>
                    </div>
                  ))}
                </div>
                {/* Time slots body — staff-style: day columns with absolute-positioned blocks */}
                <div className="flex">
                  {/* Time labels column */}
                  <div className="w-[60px] shrink-0 bg-background">
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
                      const dateKey = formatDateKey(day);
                      const dayReservations = reservationsByDate[dateKey] || [];
                      const overlapItems = dayReservations
                        .filter((r) => r.start_at && r.end_at)
                        .map((r) => {
                          const s = new Date(r.start_at);
                          const e = new Date(r.end_at);
                          return { id: r.id, top: (s.getHours() - 6) * 60 + s.getMinutes() - 30, bottom: (e.getHours() - 6) * 60 + e.getMinutes() - 30 };
                        })
                        .filter((it) => it.bottom > it.top);
                      const overlap = layoutOverlapping(overlapItems);
                      return (
                        <div key={dayIndex} className="relative border-l">
                          {/* Slot backgrounds (drag-create) */}
                          {timeSlots.map((slot) => (
                            <div
                              key={slot.label}
                              data-week-cell
                              data-week-date={dateKey}
                              data-slot-hour={slot.hour}
                              data-slot-minute={slot.minute}
                              className={cn(
                                "h-[5px] cursor-pointer",
                                slot.minute === 55 ? "border-b border-b-border" : slot.minute % 30 === 25 ? "border-b border-b-border/30" : "",
                                (isOutsideBusinessHours(day, slot.hour, slot.minute) || (selectedStaff !== "all" && isStaffOff(selectedStaff, day, slot.hour, slot.minute))) && "bg-gray-200/60"
                              )}
                              onPointerDown={(e) => handleWeekPointerDown(e, day, slot.hour, slot.minute)}
                              onPointerUp={clearWeekDragTimer}
                              onPointerCancel={clearWeekDragTimer}
                              onContextMenu={(e) => e.preventDefault()}
                            />
                          ))}
                          {/* Reservation blocks */}
                          {dayReservations.map((r) => {
                            if (!r.start_at || !r.end_at) return null;
                            const s = new Date(r.start_at);
                            const e = new Date(r.end_at);
                            const startOffset = (s.getHours() - 6) * 60 + s.getMinutes() - 30;
                            const endOffset = (e.getHours() - 6) * 60 + e.getMinutes() - 30;
                            const duration = endOffset - startOffset;
                            if (duration <= 0) return null;
                            const topPx = (startOffset / 5) * 5;
                            const heightPx = (duration / 5) * 5;
                            const ol = overlap.get(r.id);
                            const col = ol?.col ?? 0;
                            const total = ol?.total ?? 1;
                            const startTimeStr = `${s.getHours()}:${s.getMinutes().toString().padStart(2, "0")}`;
                            const endTimeStr = `${e.getHours()}:${e.getMinutes().toString().padStart(2, "0")}`;
                            return (
                              <div
                                key={r.id}
                                className={cn(
                                  "absolute rounded border px-0.5 overflow-hidden z-10 cursor-pointer",
                                  (r.status === "cancelled" || r.status === "noshow") && "line-through"
                                )}
                                style={{
                                  ...getReservationStyle(r),
                                  top: `${topPx + 1}px`,
                                  height: `${heightPx - 2}px`,
                                  left: `calc(${(col / total) * 100}% + 1px)`,
                                  width: `calc(${(1 / total) * 100}% - 2px)`,
                                }}
                                title={`${r.customer_name} - ${r.menu_name} (${r.staff_name})`}
                                onClick={(e) => { e.stopPropagation(); router.push(`/reservations/${r.id}`); }}
                              >
                                <div className="flex items-center gap-0.5">
                                  {(r.is_new_customer != null ? r.is_new_customer === 1 : r.customer_visit_count === 0) && (
                                    <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#3A76FD" }}>新</span>
                                  )}
                                  {r.source === "hotpepper" && (
                                    <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#CB006D" }}>HPB</span>
                                  )}
                                  {r.source === "minimo" && (
                                    <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#00A7FF" }}>mini</span>
                                  )}
                                  {r.is_nominated === 1 ? (
                                    <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#FD7878" }}>指名</span>
                                  ) : r.is_nominated === 0 && (
                                    <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#3A76FD" }}>フリー</span>
                                  )}
                                  {r.has_consent && (
                                    <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#F36C21" }}>同意済</span>
                                  )}
                                  {r.salonboard_synced === 1 && (
                                    <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] bg-blue-600 text-white rounded-sm font-normal shrink-0">SB</span>
                                  )}
                                  {r.salonboard_synced === -1 && (
                                    <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] bg-red-600 text-white rounded-sm font-normal shrink-0">SB!</span>
                                  )}
                                </div>
                                <div className="text-[11px] font-medium truncate" style={{ color: "#1a1a1a" }}>
                                  {r.customer_name || "顧客"}
                                </div>
                                {heightPx >= 7 && (
                                  <div className="text-[10px] truncate" style={{ color: "#1a1a1a" }}>
                                    {startTimeStr}-{endTimeStr}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            // Day View - with axis toggle
            <div>
              {/* Axis toggle button */}
              <div className="flex justify-end mb-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDayViewAxis(dayViewAxis === "staff-row" ? "time-row" : "staff-row")}
                  className="text-xs h-7 px-2"
                >
                  <RotateCcw className="h-3 w-3 mr-1" />
                  {dayViewAxis === "staff-row" ? "時間を縦軸に" : "スタッフを縦軸に"}
                </Button>
              </div>

              {staffList.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">
                  スタッフが登録されていません
                </div>
              ) : dayViewAxis === "staff-row" ? (
                // Staff rows × Time columns
                <div className="border rounded-lg overflow-hidden">
                  {/* Header row */}
                  <div className="flex bg-muted/30 border-b">
                    {/* Staff header - avatar size */}
                    <div className="w-[56px] md:w-[64px] shrink-0 h-8 md:h-10 flex items-center justify-center text-xs font-medium text-muted-foreground border-r">
                      <User className="h-4 w-4" />
                    </div>
                    {/* Time headers - scrollable horizontally */}
                    <div className="flex-1 overflow-x-auto" id="day-time-header">
                      <div className="flex min-w-max">
                        {timeSlots.map((slot) => (
                          <div
                            key={slot.label}
                            className="w-[7px] md:w-[10px] shrink-0 h-8 md:h-10 relative"
                          >
                            {slot.minute === 0 && (
                              <span className="absolute -left-[6px] md:-left-[8px] top-0 bottom-0 flex items-center text-[10px] md:text-xs font-medium text-muted-foreground leading-none">
                                {slot.hour}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Staff rows container - 7 rows visible */}
                  <div className="max-h-[350px] md:max-h-[420px] overflow-y-auto" id="day-staff-container">
                    {staffList.map((staffMember) => {
                      const staffReservations = activeReservations.filter(
                        (r) => r.staff_id === staffMember.id
                      );

                      return (
                        <div
                          key={staffMember.id}
                          className="flex border-b last:border-b-0 transition-colors"
                          onDragOver={handleDragOver}
                          onDragEnter={handleDragEnter}
                          onDragLeave={handleDragLeave}
                          onDrop={(e) => handleDrop(e, staffMember.id)}
                        >
                          <div
                            className={cn(
                              "w-[56px] md:w-[64px] shrink-0 h-[50px] md:h-[60px] flex flex-col items-center justify-center border-r py-1 cursor-pointer transition-colors",
                              selectedStaff === staffMember.id ? "bg-primary/10 ring-2 ring-primary ring-inset" : "bg-muted/10 hover:bg-muted/30"
                            )}
                            onClick={() => setSelectedStaff(staffMember.id)}
                            title={staffMember.name}
                          >
                            <Avatar className={cn(
                              "h-6 w-6 md:h-8 md:w-8",
                              selectedStaff === staffMember.id && "ring-2 ring-primary"
                            )}>
                              {staffMember.avatar_url && <AvatarImage src={getImageUrl(staffMember.avatar_url) || undefined} />}
                              <AvatarFallback className="text-[10px] md:text-xs">{staffMember.name.charAt(0)}</AvatarFallback>
                            </Avatar>
                            <span className={cn(
                              "text-[8px] md:text-[10px] mt-0.5 truncate max-w-[52px] md:max-w-[60px]",
                              selectedStaff === staffMember.id ? "text-primary font-medium" : "text-muted-foreground"
                            )}>{staffMember.name}</span>
                          </div>
                          <div
                            className="flex-1 overflow-x-auto day-time-scroll"
                            onDragOver={handleDragOver}
                            onDragEnter={handleDragEnter}
                            onDragLeave={handleDragLeave}
                            onDrop={(e) => handleDrop(e, staffMember.id)}
                            onScroll={(e) => {
                              const header = document.getElementById('day-time-header');
                              if (header) {
                                header.scrollLeft = e.currentTarget.scrollLeft;
                              }
                              document.querySelectorAll<HTMLElement>('.day-time-scroll').forEach((el) => {
                                if (el !== e.currentTarget) {
                                  el.scrollLeft = e.currentTarget.scrollLeft;
                                }
                              });
                            }}
                          >
                            <div
                              className="flex min-w-max h-[50px] md:h-[60px] relative"
                              onDragOver={handleDragOver}
                              onDrop={(e) => handleDrop(e, staffMember.id)}
                            >
                              {timeSlots.map((slot) => (
                                <div
                                  key={slot.label}
                                  className={cn(
                                    "w-[7px] md:w-[10px] shrink-0 cursor-pointer hover:bg-muted/30",
                                    slot.minute === 0 ? "border-l border-l-border" : slot.minute % 15 === 0 ? "border-l border-l-border/30" : "",
                                    (isOutsideBusinessHours(currentDate, slot.hour, slot.minute) || isStaffOff(staffMember.id, currentDate, slot.hour, slot.minute)) && "bg-gray-200/60"
                                  )}
                                  onDragOver={handleDragOver}
                                  onDragEnter={handleDragEnter}
                                  onDragLeave={handleDragLeave}
                                  onDrop={(e) => handleDropWithTime(e, staffMember.id, slot.hour, slot.minute)}
                                  onPointerDown={() => startLongPress(() => openNewReservationDialog(currentDate, slot.hour))}
                                  onPointerUp={clearLongPress}
                                  onPointerCancel={clearLongPress}
                                  onContextMenu={(e) => e.preventDefault()}
                                />
                              ))}
                              {staffReservations.map((reservation) => {
                                if (!reservation.start_at || !reservation.end_at) return null;
                                // Parse dates and get local time
                                const startDate = new Date(reservation.start_at);
                                const endDate = new Date(reservation.end_at);
                                const startHour = startDate.getHours();
                                const startMin = startDate.getMinutes();
                                const endHour = endDate.getHours();
                                const endMin = endDate.getMinutes();
                                const startOffset = (startHour - 6) * 60 + startMin - 30;
                                const endOffset = (endHour - 6) * 60 + endMin - 30;
                                const duration = endOffset - startOffset;
                                const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
                                const slotWidth = isMobile ? 7 : 10; // 5-minute slot width
                                const left = (startOffset / 5) * slotWidth;
                                const width = (duration / 5) * slotWidth;

                                return (
                                  <div
                                    key={reservation.id}
                                    draggable
                                    onDragStart={(e) => handleDragStart(e, reservation)}
                                    onDragEnd={handleDragEnd}
                                    className={cn(
                                      "absolute top-1 bottom-1 rounded border px-1 md:px-2 py-0.5 cursor-grab text-[10px] md:text-xs overflow-hidden",
                                      getStatusColor(reservation.status)
                                    )}
                                    style={{
                                      left: `${left}px`,
                                      width: `${Math.max(width - 4, 30)}px`,
                                      ...getReservationStyle(reservation),
                                    }}
                                    title={`${reservation.customer_name} - ${reservation.menu_name}（ドラッグで移動）`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      router.push(`/reservations/${reservation.id}`);
                                    }}
                                  >
                                    <div className="font-medium truncate flex items-center gap-1">
                                      {reservation.customer_name}
                                      {(reservation.is_new_customer != null ? reservation.is_new_customer === 1 : reservation.customer_visit_count === 0) && (
                                        <span className="inline-flex items-center px-0.5 text-[7px] leading-[11px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#3A76FD" }}>新規</span>
                                      )}
                                      {reservation.source === "hotpepper" && (
                                        <span className="inline-flex items-center px-0.5 text-[7px] leading-[11px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#CB006D" }}>HPB</span>
                                      )}
                                      {reservation.source === "minimo" && (
                                        <span className="inline-flex items-center px-0.5 text-[7px] leading-[11px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#00A7FF" }}>minimo</span>
                                      )}
                                      {reservation.has_consent && (
                                        <span className="inline-flex items-center px-0.5 text-[7px] leading-[11px] text-white rounded-sm font-normal shrink-0 " style={{ backgroundColor: "#F36C21" }}>同意済</span>
                                      )}
                                      {reservation.is_nominated === 1 ? (
                                        <span className="inline-flex items-center px-0.5 text-[7px] leading-[11px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#FD7878" }}>指名</span>
                                      ) : reservation.is_nominated === 0 && (
                                        <span className="inline-flex items-center px-0.5 text-[7px] leading-[11px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#3A76FD" }}>フリー</span>
                                      )}
                                      {reservation.salonboard_synced === 1 && (
                                        <span className="inline-flex items-center px-0.5 text-[7px] leading-[11px] bg-blue-600 text-white rounded-sm font-normal shrink-0">SB</span>
                                      )}
                                      {reservation.salonboard_synced === -1 && (
                                        <span className="inline-flex items-center px-0.5 text-[7px] leading-[11px] bg-red-600 text-white rounded-sm font-normal shrink-0">SB!</span>
                                      )}
                                    </div>
                                    <div className="truncate text-[8px] md:text-[10px]">{reservation.menu_name}</div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                // Time rows × Staff columns (column-based with spanning reservations)
                <div className="border rounded-lg overflow-hidden">
                  {/* Header row */}
                  <div className="flex bg-muted/30 border-b">
                    {/* Time header */}
                    <div className="w-[44px] md:w-[52px] shrink-0 h-[52px] md:h-[60px] flex items-center justify-center text-xs font-medium text-muted-foreground border-r">
                      <Clock className="h-4 w-4" />
                    </div>
                    {/* Staff headers - scrollable horizontally - avatars with names */}
                    <div className="flex-1 overflow-x-auto" id="day-staff-header">
                      <div className="flex min-w-max">
                        {staffList.map((staffMember) => (
                          <div
                            key={staffMember.id}
                            className={cn(
                              "w-[80px] md:w-[100px] shrink-0 h-[52px] md:h-[60px] flex flex-col items-center justify-center border-l py-1 cursor-pointer transition-colors",
                              selectedStaff === staffMember.id ? "bg-primary/10 ring-2 ring-primary ring-inset" : "hover:bg-muted/50"
                            )}
                            onClick={() => setSelectedStaff(staffMember.id)}
                            title={staffMember.name}
                          >
                            <Avatar className={cn(
                              "h-6 w-6 md:h-8 md:w-8",
                              selectedStaff === staffMember.id && "ring-2 ring-primary"
                            )}>
                              {staffMember.avatar_url && <AvatarImage src={getImageUrl(staffMember.avatar_url) || undefined} />}
                              <AvatarFallback className="text-[10px] md:text-xs">{staffMember.name.charAt(0)}</AvatarFallback>
                            </Avatar>
                            <span className={cn(
                              "text-[8px] md:text-[10px] mt-0.5 truncate max-w-[76px] md:max-w-[96px]",
                              selectedStaff === staffMember.id ? "text-primary font-medium" : "text-muted-foreground"
                            )}>{staffMember.name}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Body - column-based layout with CSS variable for slot height */}
                  <div className="max-h-[500px] md:max-h-[700px] overflow-y-auto [--slot-h:10px] md:[--slot-h:11px]" id="day-time-container">
                    <div className="flex">
                      {/* Time labels column */}
                      <div className="w-[44px] md:w-[52px] shrink-0">
                        {timeSlots.map((slot) => (
                          <div
                            key={slot.label}
                            className={cn(
                              "h-[var(--slot-h)] relative border-r",
                              isOutsideBusinessHours(currentDate, slot.hour, slot.minute) && "bg-gray-200/60"
                            )}
                          >
                            {(slot.minute === 0 || slot.minute === 30) && (
                              <span className="absolute -top-[7px] md:-top-[8px] left-0 right-0 text-center text-[10px] md:text-xs font-medium text-muted-foreground leading-none">
                                {slot.label}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Staff columns - scrollable horizontally */}
                      <div
                        className="flex-1 overflow-x-auto"
                        id="day-staff-body"
                        onScroll={(e) => {
                          const header = document.getElementById('day-staff-header');
                          if (header) {
                            header.scrollLeft = e.currentTarget.scrollLeft;
                          }
                        }}
                      >
                        <div className="flex min-w-max">
                          {staffList.map((staffMember) => {
                            const staffReservations = activeReservations.filter(
                              (r) => r.staff_id === staffMember.id
                            );

                            return (
                              <div
                                key={staffMember.id}
                                className="w-[80px] md:w-[100px] shrink-0 relative border-l"
                              >
                                {/* Grid slot backgrounds for click/hover/drop targets */}
                                {timeSlots.map((slot, i) => (
                                  <div
                                    key={slot.label}
                                    className={cn(
                                      "h-[var(--slot-h)] cursor-pointer hover:bg-muted/30 transition-colors",
                                      slot.minute === 55 ? "border-b border-b-border" : slot.minute % 15 === 10 ? "border-b border-b-border/30" : "",
                                      i === 0 && "border-t border-t-border",
                                      (isOutsideBusinessHours(currentDate, slot.hour, slot.minute) || isStaffOff(staffMember.id, currentDate, slot.hour, slot.minute)) && "bg-gray-200/60"
                                    )}
                                    onPointerDown={() => startLongPress(() => openNewReservationDialog(currentDate, slot.hour))}
                                    onPointerUp={clearLongPress}
                                    onPointerCancel={clearLongPress}
                                    onContextMenu={(e) => e.preventDefault()}
                                    onDragOver={handleDragOver}
                                    onDragEnter={handleDragEnter}
                                    onDragLeave={handleDragLeave}
                                    onDrop={(e) => handleDropWithTime(e, staffMember.id, slot.hour, slot.minute)}
                                  />
                                ))}
                                {/* Reservation blocks - absolutely positioned spanning full duration */}
                                {staffReservations.map((reservation) => {
                                  if (!reservation.start_at || !reservation.end_at) return null;
                                  const startDate = new Date(reservation.start_at);
                                  const endDate = new Date(reservation.end_at);
                                  const startHour = startDate.getHours();
                                  const startMin = startDate.getMinutes();
                                  const endHour = endDate.getHours();
                                  const endMin = endDate.getMinutes();
                                  const startOffset = (startHour - 6) * 60 + startMin - 30;
                                  const endOffset = (endHour - 6) * 60 + endMin - 30;
                                  const duration = endOffset - startOffset;
                                  if (duration <= 0) return null;

                                  const slotsFromTop = startOffset / 5;
                                  const slotsHeight = duration / 5;

                                  const startTimeStr = `${startHour}:${startMin.toString().padStart(2, '0')}`;
                                  const endTimeStr = `${endHour}:${endMin.toString().padStart(2, '0')}`;

                                  return (
                                    <div
                                      key={reservation.id}
                                      draggable
                                      onDragStart={(e) => handleDragStart(e, reservation)}
                                      onDragEnd={handleDragEnd}
                                      className={cn(
                                        "absolute left-0.5 right-0.5 rounded border px-1 py-0.5 cursor-grab overflow-hidden z-10",
                                        getStatusColor(reservation.status),
                                        isDragging && "pointer-events-none"
                                      )}
                                      style={{
                                        top: `calc(${slotsFromTop} * var(--slot-h))`,
                                        height: `calc(${slotsHeight} * var(--slot-h) - 2px)`,
                                        ...getReservationStyle(reservation),
                                      }}
                                      title={`${reservation.customer_name} - ${reservation.menu_name}（ドラッグで移動）`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        router.push(`/reservations/${reservation.id}`);
                                      }}
                                    >
                                      {/* Line 1: Badges row (staff-style) */}
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
                                        {reservation.has_consent && (
                                          <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#F36C21" }}>同意済</span>
                                        )}
                                        {reservation.salonboard_synced === 1 && (
                                          <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] bg-blue-600 text-white rounded-sm font-normal shrink-0">SB</span>
                                        )}
                                        {reservation.salonboard_synced === -1 && (
                                          <span className="inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] bg-red-600 text-white rounded-sm font-normal shrink-0">SB!</span>
                                        )}
                                      </div>
                                      {/* Line 2: Customer name (prominent) */}
                                      <div className="text-[11px] font-medium truncate" style={{ color: "#1a1a1a" }}>
                                        {reservation.customer_name || "顧客"}
                                      </div>
                                      {/* Line 3: Time range */}
                                      {slotsHeight >= 2 && (
                                        <div className="text-[10px] truncate" style={{ color: "#1a1a1a" }}>
                                          {startTimeStr}-{endTimeStr}
                                        </div>
                                      )}
                                      {/* Line 4: Menu name (only if enough height for 3+ slots) */}
                                      {slotsHeight >= 3 && (
                                        <div className="text-[9px] truncate text-muted-foreground">
                                          {reservation.menu_name}
                                        </div>
                                      )}
                                      {/* Line 5: Price (only if enough height for 5+ slots) */}
                                      {slotsHeight >= 5 && reservation.price && (
                                        <div className="text-[9px] truncate text-muted-foreground">
                                          ¥{reservation.price.toLocaleString()}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 md:gap-4">
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xs md:text-sm text-muted-foreground">総予約数</div>
            <div className="text-xl md:text-2xl font-bold">{activeReservations.length}件</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xs md:text-sm text-muted-foreground">確認待ち</div>
            <div className="text-xl md:text-2xl font-bold text-yellow-600">
              {activeReservations.filter((r) => r.status === "pending").length}件
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xs md:text-sm text-muted-foreground">確定済み</div>
            <div className="text-xl md:text-2xl font-bold text-green-600">
              {activeReservations.filter((r) => r.status === "confirmed").length}件
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xs md:text-sm text-muted-foreground">売上見込</div>
            <div className="text-xl md:text-2xl font-bold">
              {formatPrice(
                activeReservations
                  .reduce((sum, r) => sum + (r.price || 0), 0)
              )}
            </div>
          </CardContent>
        </Card>
        <Card
          className={cn(
            "cursor-pointer transition-colors hover:bg-muted/50",
            showCancelled && "ring-2 ring-red-300"
          )}
          onClick={() => setShowCancelled(!showCancelled)}
        >
          <CardContent className="p-3 md:p-4">
            <div className="text-xs md:text-sm text-muted-foreground">キャンセル</div>
            <div className="text-xl md:text-2xl font-bold text-red-600">
              {cancelledReservations.length}件
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Cancelled reservations detail */}
      {showCancelled && cancelledReservations.length > 0 && (
        <Card className="border-red-200">
          <CardContent className="p-3 md:p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-medium text-red-600">キャンセル済み予約</div>
              <Button variant="ghost" size="sm" onClick={() => setShowCancelled(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-2">
              {cancelledReservations.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 p-2 rounded-md bg-red-50 border border-red-100 cursor-pointer hover:bg-red-100 transition-colors"
                  onClick={() => router.push(`/reservations/${r.id}`)}
                >
                  <div className="text-xs text-muted-foreground w-[70px] shrink-0">
                    {formatDate(r.start_at, "time")}~{formatDate(r.end_at, "time")}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {r.customer_name}
                      {(r.is_new_customer != null ? r.is_new_customer === 1 : r.customer_visit_count === 0) && (
                        <span className="inline-flex items-center ml-1 px-0.5 text-[7px] leading-[11px] text-white rounded-sm font-normal shrink-0" style={{ backgroundColor: "#3A76FD" }}>新規</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{r.menu_name} / {r.staff_name}</div>
                  </div>
                  <div className="shrink-0">
                    {r.status === "noshow" ? (
                      <Badge variant="destructive" className="text-[10px]">無断</Badge>
                    ) : (
                      <Badge variant="destructive" className="text-[10px]">キャンセル</Badge>
                    )}
                  </div>
                  {r.price ? (
                    <div className="text-xs text-muted-foreground shrink-0">
                      {formatPrice(r.price)}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Week drag-create ghost card */}
      {weekDragPreview && weekDragPreview.targetDate && (() => {
        const p = weekDragPreview;
        const startMinTotal = p.targetHour * 60 + p.targetMinute - 55;
        const startH = Math.max(0, Math.floor(startMinTotal / 60));
        const startM = Math.max(0, startMinTotal % 60);
        const endH = p.targetHour;
        const endM = p.targetMinute + 5; // bottom of ghost = finger cell + 1 slot
        return (
          <div
            id="week-drag-ghost"
            className="fixed z-50 pointer-events-none select-none"
            style={{
              left: p.colLeft,
              top: p.cellTop - (WEEK_CREATE_SLOTS - 1) * p.cellHeight,
              width: p.colWidth,
              height: p.cellHeight * WEEK_CREATE_SLOTS,
            }}
          >
            <div className="w-full h-full rounded border-2 border-dashed border-primary/60 bg-primary/20 px-1 py-0.5">
              <div className="text-[10px] md:text-xs font-bold text-primary flex items-center gap-0.5">
                <Plus className="h-3 w-3" />
                新規予約
              </div>
              <div className="text-[9px] md:text-[10px] font-medium text-primary/80">
                {startH}:{startM.toString().padStart(2, "0")} - {endH}:{endM.toString().padStart(2, "0")}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
