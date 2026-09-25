'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';

export interface Day { date: string; weekday: number; closed: boolean; reason: string | null }
export interface SlotItem { start: string; time: string }

const WD = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * Date strip + time slot grid backed by /api/availability.
 * `buildUrl(date)` returns the availability URL for a date (menus/staff/appointment baked in).
 */
export function SlotPicker({ days, buildUrl, selected, onSelect, busyStart, initialDate, reloadKey = 0, emptyHint }: {
  days: Day[]; buildUrl: (date: string) => string; selected: string | null; onSelect: (slot: SlotItem, date: string) => void;
  busyStart?: string | null; initialDate?: string | null; reloadKey?: number; emptyHint?: React.ReactNode;
}) {
  const firstOpen = days.find((d) => !d.closed)?.date ?? days[0]?.date ?? null;
  const [date, setDate] = useState<string | null>(initialDate && days.some((d) => d.date === initialDate && !d.closed) ? initialDate : firstOpen);
  const [slots, setSlots] = useState<SlotItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const stripRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (d: string) => {
    const my = ++seq.current;
    setLoading(true); setError(null);
    try {
      const res = await fetch(buildUrl(d), { cache: 'no-store' });
      const j = await res.json().catch(() => ({}));
      if (my !== seq.current) return;
      if (!res.ok) { setError(j.error ?? '空き状況を取得できませんでした'); setSlots(null); return; }
      setSlots(j.slots ?? []);
    } catch {
      if (my === seq.current) { setError('通信に失敗しました。電波の良い場所で再度お試しください。'); setSlots(null); }
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [buildUrl]);

  useEffect(() => { if (date) void load(date); }, [date, load, reloadKey]);
  useEffect(() => {
    const el = stripRef.current?.querySelector('.date-chip.selected') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [date]);

  if (!days.length) return <div className="alert info">現在ご予約可能な日がありません。</div>;
  const month = date ? Number(date.slice(5, 7)) : null;

  return (
    <div className="stack">
      <div>
        <div className="between" style={{ marginBottom: 6 }}>
          <b>{month ? `${month}月` : ''}</b>
          <span className="sub">× は休業日です</span>
        </div>
        <div className="date-strip" ref={stripRef} role="listbox" aria-label="日付を選択">
          {days.map((d) => {
            const [, m, dd] = d.date.split('-').map(Number);
            return (
              <button
                key={d.date} type="button" role="option" aria-selected={d.date === date} disabled={d.closed}
                className={`date-chip ${d.date === date ? 'selected' : ''}`} title={d.reason ?? undefined}
                onClick={() => setDate(d.date)}
              >
                <span className="w">{dd === 1 || d.date === days[0].date ? `${m}/` : ''}{WD[d.weekday]}</span>
                <span className="d" style={{ color: d.date === date ? undefined : d.weekday === 0 ? 'var(--red)' : d.weekday === 6 ? 'var(--accent-strong)' : undefined }}>{dd}</span>
                <span className="w">{d.closed ? '×' : '○'}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div aria-live="polite">
        {loading && <div className="slot-grid">{Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton" style={{ height: 40 }} />)}</div>}
        {!loading && error && (
          <div className="alert error between">
            <span>{error}</span>
            {date && <button type="button" className="btn secondary sm" onClick={() => load(date)}><RefreshCw size={14} />再読み込み</button>}
          </div>
        )}
        {!loading && !error && slots && slots.length === 0 && (
          <div className="alert info">この日は空きがありません。別の日をお選びください。{emptyHint}</div>
        )}
        {!loading && !error && slots && slots.length > 0 && (
          <div className="slot-grid" role="listbox" aria-label="開始時刻">
            {slots.map((s) => (
              <button
                key={s.start} type="button" role="option" aria-selected={selected === s.start}
                className={`slot ${selected === s.start ? 'selected' : ''}`} disabled={!!busyStart}
                onClick={() => date && onSelect(s, date)}
              >
                {busyStart === s.start ? <span className="spinner" /> : s.time}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
