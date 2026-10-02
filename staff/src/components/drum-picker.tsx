"use client";

import { useState, useRef, useEffect, useCallback } from "react";

interface DrumColumnProps {
  items: { value: string; label: string }[];
  selected: string;
  onChange: (value: string) => void;
}

const ITEM_HEIGHT = 44;
const VISIBLE_ITEMS = 5;
const CENTER = Math.floor(VISIBLE_ITEMS / 2);

function DrumColumn({ items, selected, onChange }: DrumColumnProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  const [renderOffset, setRenderOffset] = useState(0);
  const isDraggingRef = useRef(false);
  const startY = useRef(0);
  const startOffset = useRef(0);
  const velocity = useRef(0);
  const lastY = useRef(0);
  const lastTime = useRef(0);
  const rafRef = useRef<number | null>(null);

  const selectedIndex = items.findIndex((item) => item.value === selected);

  // Sync offset with selected index (when not dragging)
  useEffect(() => {
    if (!isDraggingRef.current) {
      const target = -selectedIndex * ITEM_HEIGHT;
      offsetRef.current = target;
      setRenderOffset(target);
    }
  }, [selectedIndex]);

  const snapToNearest = useCallback(
    (currentOffset: number) => {
      const index = Math.round(-currentOffset / ITEM_HEIGHT);
      const clamped = Math.max(0, Math.min(items.length - 1, index));
      const snapOffset = -clamped * ITEM_HEIGHT;
      offsetRef.current = snapOffset;
      setRenderOffset(snapOffset);
      if (items[clamped].value !== selected) {
        onChange(items[clamped].value);
      }
    },
    [items, selected, onChange]
  );

  const decelerate = useCallback(
    (vel: number, currentOffset: number) => {
      if (Math.abs(vel) < 0.3) {
        snapToNearest(currentOffset);
        return;
      }
      const newOffset = currentOffset + vel;
      const max = ITEM_HEIGHT;
      const min = -(items.length - 1) * ITEM_HEIGHT - ITEM_HEIGHT;
      const clamped = Math.max(min, Math.min(max, newOffset));
      offsetRef.current = clamped;
      setRenderOffset(clamped);
      rafRef.current = requestAnimationFrame(() =>
        decelerate(vel * 0.93, clamped)
      );
    },
    [items.length, snapToNearest]
  );

  // Use native event listeners for proper passive: false
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      isDraggingRef.current = true;
      startY.current = e.touches[0].clientY;
      startOffset.current = offsetRef.current;
      lastY.current = e.touches[0].clientY;
      lastTime.current = Date.now();
      velocity.current = 0;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!isDraggingRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      const y = e.touches[0].clientY;
      const diff = y - startY.current;
      const now = Date.now();
      const dt = now - lastTime.current;
      if (dt > 0) {
        velocity.current = ((y - lastY.current) / dt) * 16;
      }
      lastY.current = y;
      lastTime.current = now;
      const newOffset = startOffset.current + diff;
      const max = ITEM_HEIGHT * 2;
      const min = -(items.length - 1) * ITEM_HEIGHT - ITEM_HEIGHT * 2;
      const clamped = Math.max(min, Math.min(max, newOffset));
      offsetRef.current = clamped;
      setRenderOffset(clamped);
    };

    const onTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      isDraggingRef.current = false;
      if (Math.abs(velocity.current) > 1.5) {
        decelerate(velocity.current, offsetRef.current);
      } else {
        snapToNearest(offsetRef.current);
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [items, decelerate, snapToNearest]);

  const centerIndex = Math.round(-renderOffset / ITEM_HEIGHT);

  return (
    <div
      ref={containerRef}
      className="relative flex-1 overflow-hidden select-none"
      style={{ height: ITEM_HEIGHT * VISIBLE_ITEMS, touchAction: "none" }}
    >
      <div
        className="absolute w-full will-change-transform"
        style={{
          transform: `translate3d(0, ${renderOffset + ITEM_HEIGHT * CENTER}px, 0)`,
        }}
      >
        {items.map((item, i) => {
          const dist = Math.abs(i - centerIndex);
          return (
            <div
              key={item.value}
              className="flex items-center justify-center font-medium"
              style={{
                height: ITEM_HEIGHT,
                fontSize: dist === 0 ? 16 : 14,
                color: dist === 0 ? "#1a1a1a" : dist === 1 ? "#999" : "#ccc",
              }}
            >
              {item.label}
            </div>
          );
        })}
      </div>
      <div
        className="absolute left-0 right-0 border-t border-b border-[#b8936a]/30 pointer-events-none"
        style={{ top: ITEM_HEIGHT * CENTER, height: ITEM_HEIGHT }}
      />
    </div>
  );
}

interface BirthdayPickerProps {
  value: string;
  onChange: (value: string) => void;
}

export function BirthdayPicker({ value, onChange }: BirthdayPickerProps) {
  const currentYear = new Date().getFullYear();
  const [open, setOpen] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  const parsed = value ? value.split("-") : [];
  const [year, setYear] = useState(parsed[0] || "1990");
  const [month, setMonth] = useState(parsed[1] ? String(parseInt(parsed[1])) : "1");
  const [day, setDay] = useState(parsed[2] ? String(parseInt(parsed[2])) : "1");

  // Block ALL touch events on overlay (prevents LINE browser swipe-back)
  useEffect(() => {
    if (!open) return;
    const el = overlayRef.current;
    if (!el) return;
    const block = (e: TouchEvent) => {
      // Only allow touches inside DrumColumn (they handle their own events)
      const target = e.target as HTMLElement;
      if (!target.closest("[data-drum-column]")) {
        e.preventDefault();
      }
    };
    el.addEventListener("touchmove", block, { passive: false });
    document.body.style.overflow = "hidden";
    return () => {
      el.removeEventListener("touchmove", block);
      document.body.style.overflow = "";
    };
  }, [open]);

  const years = Array.from({ length: 100 }, (_, i) => ({
    value: String(currentYear - i),
    label: `${currentYear - i}年`,
  }));

  const months = Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1),
    label: `${i + 1}月`,
  }));

  const daysInMonth = new Date(parseInt(year), parseInt(month), 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => ({
    value: String(i + 1),
    label: `${i + 1}日`,
  }));

  const displayValue = value
    ? `${value.split("-")[0]}年${parseInt(value.split("-")[1])}月${parseInt(value.split("-")[2])}日`
    : "";

  const handleConfirm = () => {
    const d = parseInt(day) > daysInMonth ? String(daysInMonth) : day;
    onChange(`${year}-${month.padStart(2, "0")}-${d.padStart(2, "0")}`);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm text-left"
      >
        {displayValue || <span className="text-muted-foreground">生年月日を選択</span>}
      </button>

      {open && (
        <div
          ref={overlayRef}
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
          style={{ touchAction: "none" }}
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-lg bg-white rounded-t-2xl pb-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center px-4 py-3 border-b">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-sm text-gray-500 px-2 py-1"
              >
                キャンセル
              </button>
              <span className="text-sm font-medium">生年月日</span>
              <button
                type="button"
                onClick={handleConfirm}
                className="text-sm font-medium text-[#b8936a] px-2 py-1"
              >
                決定
              </button>
            </div>
            <div className="flex px-2 pt-2" data-drum-column>
              <DrumColumn items={years} selected={year} onChange={setYear} />
              <DrumColumn items={months} selected={month} onChange={setMonth} />
              <DrumColumn items={days} selected={day} onChange={setDay} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// --- Date Picker (YYYY-MM-DD with day of week) ---

const DAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];

interface DatePickerProps {
  value: string; // YYYY-MM-DD
  onChange: (value: string) => void;
  label?: string;
}

export function DatePicker({ value, onChange, label = "日付" }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  const today = new Date();
  const parsed = value ? value.split("-") : [];
  const [year, setYear] = useState(parsed[0] || String(today.getFullYear()));
  const [month, setMonth] = useState(parsed[1] ? String(parseInt(parsed[1])) : String(today.getMonth() + 1));
  const [day, setDay] = useState(parsed[2] ? String(parseInt(parsed[2])) : String(today.getDate()));

  useEffect(() => {
    if (!open) return;
    const el = overlayRef.current;
    if (!el) return;
    const block = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-drum-column]")) e.preventDefault();
    };
    el.addEventListener("touchmove", block, { passive: false });
    document.body.style.overflow = "hidden";
    return () => {
      el.removeEventListener("touchmove", block);
      document.body.style.overflow = "";
    };
  }, [open]);

  const years = [String(today.getFullYear()), String(today.getFullYear() + 1)];
  const months = Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1),
    label: `${i + 1}月`,
  }));
  const daysInMonth = new Date(parseInt(year), parseInt(month), 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const d = new Date(parseInt(year), parseInt(month) - 1, i + 1);
    const dow = DAY_NAMES[d.getDay()];
    return { value: String(i + 1), label: `${i + 1}日(${dow})` };
  });
  const yearItems = years.map((y) => ({ value: y, label: `${y}年` }));

  const getDisplayValue = () => {
    if (!value) return "";
    const d = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    const dow = DAY_NAMES[d.getDay()];
    return `${year}年${parseInt(month)}月${parseInt(day)}日(${dow})`;
  };

  const handleConfirm = () => {
    const d = parseInt(day) > daysInMonth ? String(daysInMonth) : day;
    onChange(`${year}-${month.padStart(2, "0")}-${d.padStart(2, "0")}`);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm text-left"
      >
        {getDisplayValue() || <span className="text-muted-foreground">{label}を選択</span>}
      </button>
      {open && (
        <div
          ref={overlayRef}
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
          style={{ touchAction: "none" }}
          onClick={() => setOpen(false)}
        >
          <div className="w-full max-w-lg bg-white rounded-t-2xl pb-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center px-4 py-3 border-b">
              <button type="button" onClick={() => setOpen(false)} className="text-sm text-gray-500 px-2 py-1">キャンセル</button>
              <span className="text-sm font-medium">{label}</span>
              <button type="button" onClick={handleConfirm} className="text-sm font-medium text-[#b8936a] px-2 py-1">決定</button>
            </div>
            <div className="flex px-2 pt-2" data-drum-column>
              <DrumColumn items={yearItems} selected={year} onChange={setYear} />
              <DrumColumn items={months} selected={month} onChange={setMonth} />
              <DrumColumn items={days} selected={day} onChange={setDay} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// --- Time Picker (HH:MM) ---

interface TimePickerProps {
  value: string; // HH:MM
  onChange: (value: string) => void;
  label?: string;
  minHour?: number;
  maxHour?: number;
  step?: number;
}

export function TimePicker({ value, onChange, label = "時間", minHour = 7, maxHour = 23, step = 5 }: TimePickerProps) {
  const [open, setOpen] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  const parsed = value ? value.split(":") : [];
  const [hour, setHour] = useState(parsed[0] ? String(parseInt(parsed[0])) : String(minHour));
  const [minute, setMinute] = useState(parsed[1] ? String(parseInt(parsed[1])) : "0");

  // Sync internal state when value prop changes externally
  useEffect(() => {
    if (!value) return;
    const parts = value.split(":");
    if (parts.length === 2) {
      setHour(String(parseInt(parts[0])));
      setMinute(String(parseInt(parts[1])));
    }
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const el = overlayRef.current;
    if (!el) return;
    const block = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-drum-column]")) e.preventDefault();
    };
    el.addEventListener("touchmove", block, { passive: false });
    document.body.style.overflow = "hidden";
    return () => {
      el.removeEventListener("touchmove", block);
      document.body.style.overflow = "";
    };
  }, [open]);

  const hours = Array.from({ length: maxHour - minHour + 1 }, (_, i) => ({
    value: String(minHour + i),
    label: `${minHour + i}時`,
  }));

  const minutes = Array.from({ length: Math.floor(60 / step) }, (_, i) => ({
    value: String(i * step),
    label: `${String(i * step).padStart(2, "0")}分`,
  }));

  const getDisplayValue = () => {
    if (!value) return "";
    return `${parseInt(hour)}:${String(parseInt(minute)).padStart(2, "0")}`;
  };

  const handleConfirm = () => {
    onChange(`${String(parseInt(hour)).padStart(2, "0")}:${String(parseInt(minute)).padStart(2, "0")}`);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm text-left"
      >
        {getDisplayValue() || <span className="text-muted-foreground">{label}を選択</span>}
      </button>
      {open && (
        <div
          ref={overlayRef}
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
          style={{ touchAction: "none" }}
          onClick={() => setOpen(false)}
        >
          <div className="w-full max-w-lg bg-white rounded-t-2xl pb-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center px-4 py-3 border-b">
              <button type="button" onClick={() => setOpen(false)} className="text-sm text-gray-500 px-2 py-1">キャンセル</button>
              <span className="text-sm font-medium">{label}</span>
              <button type="button" onClick={handleConfirm} className="text-sm font-medium text-[#b8936a] px-2 py-1">決定</button>
            </div>
            <div className="flex px-2 pt-2" data-drum-column>
              <DrumColumn items={hours} selected={hour} onChange={setHour} />
              <DrumColumn items={minutes} selected={minute} onChange={setMinute} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// --- DateTime Picker (date + start time in one picker) ---

interface DateTimePickerProps {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  onDateChange: (date: string) => void;
  onTimeChange: (time: string) => void;
  label?: string;
}

const DT_DAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];

export function DateTimePicker({ date, time, onDateChange, onTimeChange, label = "日時" }: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  const today = new Date();
  const dp = date ? date.split("-") : [];
  const tp = time ? time.split(":") : [];

  const [year, setYear] = useState(dp[0] || String(today.getFullYear()));
  const [month, setMonth] = useState(dp[1] ? String(parseInt(dp[1])) : String(today.getMonth() + 1));
  const [day, setDay] = useState(dp[2] ? String(parseInt(dp[2])) : String(today.getDate()));
  const [hour, setHour] = useState(tp[0] ? String(parseInt(tp[0])) : "10");
  const [minute, setMinute] = useState(tp[1] ? String(parseInt(tp[1])) : "0");

  useEffect(() => {
    if (!open) return;
    const el = overlayRef.current;
    if (!el) return;
    const block = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-drum-column]")) e.preventDefault();
    };
    el.addEventListener("touchmove", block, { passive: false });
    document.body.style.overflow = "hidden";
    return () => {
      el.removeEventListener("touchmove", block);
      document.body.style.overflow = "";
    };
  }, [open]);

  const years = [String(today.getFullYear()), String(today.getFullYear() + 1)];
  const yearItems = years.map((y) => ({ value: y, label: `${y}年` }));
  const monthItems = Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1), label: `${i + 1}月`,
  }));
  const daysInMonth = new Date(parseInt(year), parseInt(month), 0).getDate();
  const dayItems = Array.from({ length: daysInMonth }, (_, i) => {
    const d = new Date(parseInt(year), parseInt(month) - 1, i + 1);
    return { value: String(i + 1), label: `${i + 1}(${DT_DAY_NAMES[d.getDay()]})` };
  });
  const hourItems = Array.from({ length: 17 }, (_, i) => ({
    value: String(7 + i), label: `${7 + i}時`,
  }));
  const minuteItems = Array.from({ length: 12 }, (_, i) => ({
    value: String(i * 5), label: `${String(i * 5).padStart(2, "0")}分`,
  }));

  const getDisplayValue = () => {
    if (!date || !time) return "";
    const d = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    const dow = DT_DAY_NAMES[d.getDay()];
    return `${parseInt(month)}/${parseInt(day)}(${dow}) ${parseInt(hour)}:${String(parseInt(minute)).padStart(2, "0")}`;
  };

  const handleConfirm = () => {
    const d = parseInt(day) > daysInMonth ? String(daysInMonth) : day;
    onDateChange(`${year}-${month.padStart(2, "0")}-${d.padStart(2, "0")}`);
    onTimeChange(`${String(parseInt(hour)).padStart(2, "0")}:${String(parseInt(minute)).padStart(2, "0")}`);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm text-left"
      >
        {getDisplayValue() || <span className="text-muted-foreground">{label}を選択</span>}
      </button>
      {open && (
        <div
          ref={overlayRef}
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
          style={{ touchAction: "none" }}
          onClick={() => setOpen(false)}
        >
          <div className="w-full max-w-lg bg-white rounded-t-2xl pb-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center px-4 py-3 border-b">
              <button type="button" onClick={() => setOpen(false)} className="text-sm text-gray-500 px-2 py-1">キャンセル</button>
              <span className="text-sm font-medium">{label}</span>
              <button type="button" onClick={handleConfirm} className="text-sm font-medium text-[#b8936a] px-2 py-1">決定</button>
            </div>
            <div className="flex px-1 pt-2" data-drum-column>
              <DrumColumn items={yearItems} selected={year} onChange={setYear} />
              <DrumColumn items={monthItems} selected={month} onChange={setMonth} />
              <DrumColumn items={dayItems} selected={day} onChange={setDay} />
              <DrumColumn items={hourItems} selected={hour} onChange={setHour} />
              <DrumColumn items={minuteItems} selected={minute} onChange={setMinute} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
