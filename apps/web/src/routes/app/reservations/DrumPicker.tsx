/**
 * Drum-roll pickers (bottom sheet) for the reservation form: date + time, and time only.
 * Each column snaps to 44px rows; flick with a finger, turn the mouse wheel, or click a row.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const ROW = 44;
const VISIBLE_BEFORE = 2;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

interface DrumItem {
  value: string;
  label: string;
}

function DrumColumn({
  items,
  selected,
  onChange,
}: {
  items: DrumItem[];
  selected: string;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  const [offset, setOffset] = useState(0);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startOffset = useRef(0);
  const velocity = useRef(0);
  const lastY = useRef(0);
  const lastTime = useRef(0);
  const frame = useRef<number | null>(null);
  const selectedIndex = items.findIndex((i) => i.value === selected);

  useEffect(() => {
    if (!dragging.current) {
      const o = -(ROW * Math.max(0, selectedIndex));
      offsetRef.current = o;
      setOffset(o);
    }
  }, [selectedIndex]);

  const snap = useCallback(
    (o: number) => {
      const index = Math.max(0, Math.min(items.length - 1, Math.round(-o / ROW)));
      const snapped = -(ROW * index);
      offsetRef.current = snapped;
      setOffset(snapped);
      if (items[index] && items[index].value !== selected) onChange(items[index].value);
    },
    [items, selected, onChange],
  );

  const glide = useCallback(
    (v: number, o: number) => {
      if (Math.abs(v) < 0.3) return snap(o);
      const next = Math.max(-(ROW * (items.length - 1)) - ROW, Math.min(ROW, o + v));
      offsetRef.current = next;
      setOffset(next);
      frame.current = requestAnimationFrame(() => glide(v * 0.93, next));
    },
    [items.length, snap],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onStart = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (frame.current) cancelAnimationFrame(frame.current);
      dragging.current = true;
      startY.current = e.touches[0]!.clientY;
      startOffset.current = offsetRef.current;
      lastY.current = e.touches[0]!.clientY;
      lastTime.current = Date.now();
      velocity.current = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!dragging.current) return;
      e.preventDefault();
      e.stopPropagation();
      const y = e.touches[0]!.clientY;
      const now = Date.now();
      const dt = now - lastTime.current;
      if (dt > 0) velocity.current = ((y - lastY.current) / dt) * 16;
      lastY.current = y;
      lastTime.current = now;
      const next = Math.max(
        -(ROW * (items.length - 1)) - ROW * 2,
        Math.min(ROW * 2, startOffset.current + (y - startY.current)),
      );
      offsetRef.current = next;
      setOffset(next);
    };
    const onEnd = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragging.current = false;
      if (Math.abs(velocity.current) > 1.5) glide(velocity.current, offsetRef.current);
      else snap(offsetRef.current);
    };
    // mouse wheel: one notch = one row
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      snap(offsetRef.current - Math.sign(e.deltaY) * ROW);
    };
    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('wheel', onWheel);
    };
  }, [items, glide, snap]);

  const current = Math.round(-offset / ROW);
  return (
    <div
      ref={ref}
      className="relative flex-1 select-none overflow-hidden"
      style={{ height: 220, touchAction: 'none' }}
    >
      <div
        className="absolute w-full will-change-transform"
        style={{ transform: `translate3d(0, ${offset + ROW * VISIBLE_BEFORE}px, 0)` }}
      >
        {items.map((item, i) => {
          const distance = Math.abs(i - current);
          return (
            <div
              key={item.value}
              className="flex items-center justify-center font-medium"
              style={{
                height: ROW,
                fontSize: distance === 0 ? 16 : 14,
                color: distance === 0 ? '#1a1a1a' : distance === 1 ? '#999' : '#ccc',
              }}
              onClick={() => snap(-(ROW * i))}
            >
              {item.label}
            </div>
          );
        })}
      </div>
      <div
        className="pointer-events-none absolute left-0 right-0 border-b border-t border-primary/30"
        style={{ top: ROW * VISIBLE_BEFORE, height: ROW }}
      />
    </div>
  );
}

function Sheet({
  title,
  onCancel,
  onConfirm,
  padding,
  children,
}: {
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
  padding: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onMove = (e: TouchEvent) => {
      if (!(e.target as HTMLElement).closest('[data-drum-column]')) e.preventDefault();
    };
    el.addEventListener('touchmove', onMove, { passive: false });
    document.body.style.overflow = 'hidden';
    return () => {
      el.removeEventListener('touchmove', onMove);
      document.body.style.overflow = '';
    };
  }, []);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      style={{ touchAction: 'none' }}
      onClick={onCancel}
    >
      <div className="w-full max-w-lg rounded-t-2xl bg-white pb-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <button type="button" onClick={onCancel} className="px-2 py-1 text-sm text-gray-500">
            キャンセル
          </button>
          <span className="text-sm font-medium">{title}</span>
          <button type="button" onClick={onConfirm} className="px-2 py-1 text-sm font-medium text-primary">
            決定
          </button>
        </div>
        <div className={padding} data-drum-column>
          {children}
        </div>
      </div>
    </div>
  );
}

const TRIGGER = 'w-full h-10 rounded-md border border-input bg-background px-3 text-sm text-left';
const pad2 = (n: number | string) => String(n).padStart(2, '0');

/** 終了時間: hour (7–23時) and minute (5-minute steps); value is "HH:mm" */
export function TimeDrumPicker({
  value,
  onChange,
  label = '時間',
  minHour = 7,
  maxHour = 23,
  step = 5,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  minHour?: number;
  maxHour?: number;
  step?: number;
}) {
  const [open, setOpen] = useState(false);
  const parts = value ? value.split(':') : [];
  const [hour, setHour] = useState(parts[0] ? String(parseInt(parts[0], 10)) : String(minHour));
  const [minute, setMinute] = useState(parts[1] ? String(parseInt(parts[1], 10)) : '0');
  // follow changes made outside the picker (e.g. the end time recalculated from the menus)
  useEffect(() => {
    const p = value ? value.split(':') : [];
    if (p[0]) setHour(String(parseInt(p[0], 10)));
    if (p[1]) setMinute(String(parseInt(p[1], 10)));
  }, [value]);

  const hours = Array.from({ length: maxHour - minHour + 1 }, (_, i) => ({
    value: String(minHour + i),
    label: `${minHour + i}時`,
  }));
  const minutes = Array.from({ length: Math.floor(60 / step) }, (_, i) => ({
    value: String(i * step),
    label: `${pad2(i * step)}分`,
  }));
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={TRIGGER}>
        {value ? (
          `${parseInt(hour, 10)}:${pad2(parseInt(minute, 10))}`
        ) : (
          <span className="text-muted-foreground">{label}を選択</span>
        )}
      </button>
      {open ? (
        <Sheet
          title={label}
          padding="flex px-2 pt-2"
          onCancel={() => setOpen(false)}
          onConfirm={() => {
            onChange(`${pad2(parseInt(hour, 10))}:${pad2(parseInt(minute, 10))}`);
            setOpen(false);
          }}
        >
          <DrumColumn items={hours} selected={hour} onChange={setHour} />
          <DrumColumn items={minutes} selected={minute} onChange={setMinute} />
        </Sheet>
      ) : null}
    </>
  );
}

/** 開始日時: year (this / next), month, day with weekday, hour (7–23時), minute (5-minute steps) */
export function DateTimeDrumPicker({
  date,
  time,
  onDateChange,
  onTimeChange,
  label = '日時',
}: {
  date: string;
  time: string;
  onDateChange: (date: string) => void;
  onTimeChange: (time: string) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const now = new Date();
  const d = date ? date.split('-') : [];
  const t = time ? time.split(':') : [];
  const [year, setYear] = useState(d[0] || String(now.getFullYear()));
  const [month, setMonth] = useState(d[1] ? String(parseInt(d[1], 10)) : String(now.getMonth() + 1));
  const [day, setDay] = useState(d[2] ? String(parseInt(d[2], 10)) : String(now.getDate()));
  const [hour, setHour] = useState(t[0] ? String(parseInt(t[0], 10)) : '10');
  const [minute, setMinute] = useState(t[1] ? String(parseInt(t[1], 10)) : '0');
  // follow values restored after the first render (query string, saved draft)
  useEffect(() => {
    const p = date ? date.split('-') : [];
    if (p[0]) setYear(p[0]);
    if (p[1]) setMonth(String(parseInt(p[1], 10)));
    if (p[2]) setDay(String(parseInt(p[2], 10)));
  }, [date]);
  useEffect(() => {
    const p = time ? time.split(':') : [];
    if (p[0]) setHour(String(parseInt(p[0], 10)));
    if (p[1]) setMinute(String(parseInt(p[1], 10)));
  }, [time]);

  const years = [String(now.getFullYear()), String(now.getFullYear() + 1)].map((y) => ({
    value: y,
    label: `${y}年`,
  }));
  const months = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}月` }));
  const daysInMonth = new Date(parseInt(year, 10), parseInt(month, 10), 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const wd = new Date(parseInt(year, 10), parseInt(month, 10) - 1, i + 1).getDay();
    return { value: String(i + 1), label: `${i + 1}(${WEEKDAYS[wd]})` };
  });
  const hours = Array.from({ length: 17 }, (_, i) => ({ value: String(7 + i), label: `${7 + i}時` }));
  const minutes = Array.from({ length: 12 }, (_, i) => ({ value: String(5 * i), label: `${pad2(5 * i)}分` }));

  const text = (() => {
    if (!date || !time) return '';
    const wd = WEEKDAYS[new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10)).getDay()];
    return `${parseInt(month, 10)}/${parseInt(day, 10)}(${wd}) ${parseInt(hour, 10)}:${pad2(parseInt(minute, 10))}`;
  })();
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={TRIGGER}>
        {text || <span className="text-muted-foreground">{label}を選択</span>}
      </button>
      {open ? (
        <Sheet
          title={label}
          padding="flex px-1 pt-2"
          onCancel={() => setOpen(false)}
          onConfirm={() => {
            const dd = parseInt(day, 10) > daysInMonth ? String(daysInMonth) : day;
            onDateChange(`${year}-${pad2(month)}-${pad2(dd)}`);
            onTimeChange(`${pad2(parseInt(hour, 10))}:${pad2(parseInt(minute, 10))}`);
            setOpen(false);
          }}
        >
          <DrumColumn items={years} selected={year} onChange={setYear} />
          <DrumColumn items={months} selected={month} onChange={setMonth} />
          <DrumColumn items={days} selected={day} onChange={setDay} />
          <DrumColumn items={hours} selected={hour} onChange={setHour} />
          <DrumColumn items={minutes} selected={minute} onChange={setMinute} />
        </Sheet>
      ) : null}
    </>
  );
}
