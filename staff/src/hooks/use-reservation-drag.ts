"use client";

import { useRef, useState, useEffect, useCallback } from "react";

type Reservation = {
  id: string;
  start_at: string;
  end_at: string;
  status: string;
};

export type DragPreview = {
  reservationId: string;
  slotsFromTop: number;
  slotsHeight: number;
  dragDate: string;
  isInvalid: boolean;
};

type DragState = {
  active: boolean;
  reservationId: string;
  startDate: string;
  dragDate: string;
  startY: number;
  startSlotTop: number;
  currentSlotTop: number;
  slotsHeight: number;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  initialScrollTop: number;
  hasMoved: boolean;
  pointerType: string;
};

const LONG_PRESS_MS = 400;
const MOVE_THRESHOLD = 8;
const TOTAL_SLOTS = 192; // 6:30 to 22:30 in 5-min increments
const EDGE_ZONE = 40;
const SCROLL_SPEED = 4;

function normalizeDate(dateStr: string): Date {
  let normalized = dateStr;
  if (!dateStr.endsWith("Z") && !dateStr.includes("+")) {
    normalized = dateStr.replace(" ", "T") + "Z";
  }
  return new Date(normalized);
}

function toJST(dateStr: string) {
  const d = normalizeDate(dateStr);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return { hour: jst.getUTCHours(), minute: jst.getUTCMinutes() };
}

function toJSTDateKey(dateStr: string): string {
  const d = normalizeDate(dateStr);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const year = jst.getUTCFullYear();
  const month = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jst.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function slotsToTime(slotsFromTop: number): { hour: number; minute: number } {
  const totalMinutes = slotsFromTop * 5 + 6 * 60 + 30;
  return { hour: Math.floor(totalMinutes / 60), minute: totalMinutes % 60 };
}

function timeToUTC(date: string, hour: number, minute: number): string {
  return new Date(
    `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`
  ).toISOString();
}

export function formatDragTime(slotsFromTop: number): string {
  const { hour, minute } = slotsToTime(slotsFromTop);
  return `${hour}:${String(minute).padStart(2, "0")}`;
}

export function isDraggableStatus(status: string): boolean {
  return status === "pending" || status === "confirmed";
}

export function useReservationDrag(config: {
  slotHeight: number;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  resolveDateFromX?: (clientX: number) => string | null;
  canDrop?: (reservationId: string, date: string, slotsFromTop: number, slotsHeight: number) => boolean;
  onDrop: (reservationId: string, newStartAt: string, newEndAt: string) => Promise<void>;
}) {
  const { slotHeight, scrollContainerRef, resolveDateFromX, canDrop, onDrop } = config;

  const dragRef = useRef<DragState | null>(null);
  const autoScrollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pointerYRef = useRef(0);
  const justFinishedDragRef = useRef(false);

  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUpdating, setIsUpdating] = useState<string | null>(null);

  const cleanup = useCallback(() => {
    if (dragRef.current?.longPressTimer) {
      clearTimeout(dragRef.current.longPressTimer);
    }
    if (autoScrollRef.current) {
      clearInterval(autoScrollRef.current);
      autoScrollRef.current = null;
    }
    dragRef.current = null;
    setDragPreview(null);
    setIsDragging(false);
  }, []);

  const startAutoScroll = useCallback(() => {
    if (autoScrollRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    autoScrollRef.current = setInterval(() => {
      const rect = container.getBoundingClientRect();
      const y = pointerYRef.current;
      if (y < rect.top + EDGE_ZONE) {
        container.scrollTop -= SCROLL_SPEED;
      } else if (y > rect.bottom - EDGE_ZONE) {
        container.scrollTop += SCROLL_SPEED;
      }
    }, 16);
  }, [scrollContainerRef]);

  const calculateSnappedSlot = useCallback(
    (pointerY: number): number => {
      const state = dragRef.current;
      if (!state) return 0;
      const container = scrollContainerRef.current;
      const scrollDelta = container ? container.scrollTop - state.initialScrollTop : 0;
      const deltaY = pointerY - state.startY + scrollDelta;
      const deltaSlots = Math.round(deltaY / slotHeight);
      const newSlot = state.startSlotTop + deltaSlots;
      return Math.max(0, Math.min(TOTAL_SLOTS - state.slotsHeight, newSlot));
    },
    [slotHeight, scrollContainerRef]
  );

  const activateDrag = useCallback(() => {
    const state = dragRef.current;
    if (!state || state.active) return;

    state.active = true;
    setIsDragging(true);
    const invalid = canDrop ? !canDrop(state.reservationId, state.dragDate, state.startSlotTop, state.slotsHeight) : false;
    setDragPreview({
      reservationId: state.reservationId,
      slotsFromTop: state.startSlotTop,
      slotsHeight: state.slotsHeight,
      dragDate: state.dragDate,
      isInvalid: invalid,
    });
    startAutoScroll();

    // Haptic feedback
    if (navigator.vibrate) {
      navigator.vibrate(50);
    }
  }, [startAutoScroll]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, reservation: Reservation) => {
      if (!isDraggableStatus(reservation.status)) return;
      if (isUpdating) return;

      e.stopPropagation();

      const start = toJST(reservation.start_at);
      const end = toJST(reservation.end_at);
      const startSlotTop = ((start.hour - 6) * 60 + start.minute - 30) / 5;
      const endSlotTop = ((end.hour - 6) * 60 + end.minute - 30) / 5;
      const slotsHeight = endSlotTop - startSlotTop;

      const container = scrollContainerRef.current;
      const initialScrollTop = container ? container.scrollTop : 0;

      pointerYRef.current = e.clientY;

      const dateKey = toJSTDateKey(reservation.start_at);
      const state: DragState = {
        active: false,
        reservationId: reservation.id,
        startDate: dateKey,
        dragDate: dateKey,
        startY: e.clientY,
        startSlotTop,
        currentSlotTop: startSlotTop,
        slotsHeight,
        longPressTimer: null,
        initialScrollTop,
        hasMoved: false,
        pointerType: e.pointerType,
      };

      if (e.pointerType === "touch") {
        state.longPressTimer = setTimeout(() => {
          if (dragRef.current && !dragRef.current.hasMoved) {
            activateDrag();
          }
        }, LONG_PRESS_MS);
      }

      dragRef.current = state;
    },
    [scrollContainerRef, activateDrag, isUpdating]
  );

  // Global pointer move/up handlers
  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;

      pointerYRef.current = e.clientY;

      if (!state.active) {
        const dy = Math.abs(e.clientY - state.startY);

        if (state.pointerType === "mouse" && dy >= 5) {
          // Mouse: start drag immediately on movement
          state.hasMoved = true;
          if (state.longPressTimer) clearTimeout(state.longPressTimer);
          activateDrag();
          return;
        }

        if (dy > MOVE_THRESHOLD) {
          // Touch: cancel long-press (this is a scroll)
          state.hasMoved = true;
          if (state.longPressTimer) {
            clearTimeout(state.longPressTimer);
            state.longPressTimer = null;
          }
        }
        return;
      }

      // Active drag: calculate new snapped position and check date change
      const newSlot = calculateSnappedSlot(e.clientY);
      let newDate = state.dragDate;
      if (resolveDateFromX) {
        const resolved = resolveDateFromX(e.clientX);
        if (resolved) newDate = resolved;
      }

      if (newSlot !== state.currentSlotTop || newDate !== state.dragDate) {
        state.currentSlotTop = newSlot;
        state.dragDate = newDate;
        const invalid = canDrop ? !canDrop(state.reservationId, newDate, newSlot, state.slotsHeight) : false;
        setDragPreview({
          reservationId: state.reservationId,
          slotsFromTop: newSlot,
          slotsHeight: state.slotsHeight,
          dragDate: newDate,
          isInvalid: invalid,
        });
      }
    };

    const handlePointerUp = async () => {
      const state = dragRef.current;
      if (!state) return;

      if (state.longPressTimer) {
        clearTimeout(state.longPressTimer);
      }

      if (state.active && dragPreview) {
        const { reservationId, slotsFromTop, slotsHeight } = dragPreview;

        // If position and date didn't change, just cancel
        if (slotsFromTop === state.startSlotTop && state.dragDate === state.startDate) {
          cleanup();
          return;
        }

        // If drop target is invalid, cancel
        if (dragPreview.isInvalid) {
          cleanup();
          return;
        }

        // Calculate new UTC times (use the date from the dragged reservation)
        const newStart = slotsToTime(slotsFromTop);
        const newEnd = slotsToTime(slotsFromTop + slotsHeight);
        const newStartAt = timeToUTC(state.dragDate, newStart.hour, newStart.minute);
        const newEndAt = timeToUTC(state.dragDate, newEnd.hour, newEnd.minute);

        setIsUpdating(reservationId);
        cleanup();
        justFinishedDragRef.current = true;
        setTimeout(() => { justFinishedDragRef.current = false; }, 200);

        try {
          await onDrop(reservationId, newStartAt, newEndAt);
        } finally {
          setIsUpdating(null);
        }
      } else {
        cleanup();
      }
    };

    const handlePointerCancel = () => {
      cleanup();
    };

    const handleContextMenu = (e: Event) => {
      if (dragRef.current) e.preventDefault();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("contextmenu", handleContextMenu);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [activateDrag, calculateSnappedSlot, cleanup, dragPreview, resolveDateFromX, canDrop, onDrop]);

  // Prevent scroll during active drag (touch)
  useEffect(() => {
    if (!isDragging) return;

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault();
    };

    document.addEventListener("touchmove", handleTouchMove, { passive: false });
    return () => {
      document.removeEventListener("touchmove", handleTouchMove);
    };
  }, [isDragging]);

  return {
    isDragging,
    dragPreview,
    isUpdating,
    justFinishedDragRef,
    handlePointerDown,
  };
}
