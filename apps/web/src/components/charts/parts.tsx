import { useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Card, Segmented } from '../ui';
import './charts.css';
import { formatDelta } from './scale';

export interface LegendItem {
  label: string;
  color: string;
  shape?: 'line' | 'rect';
}

/** Legend: mirrors the mark (line key for lines, swatch for bars). Text stays in text tokens. */
export function Legend({ items, className }: { items: LegendItem[]; className?: string }) {
  return (
    <ul className={cn('viz flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted', className)}>
      {items.map((it) => (
        <li key={it.label} className="inline-flex items-center gap-1.5">
          {it.shape === 'line' ? (
            <span className="inline-block h-0.5 w-4 rounded-full" style={{ background: it.color }} aria-hidden />
          ) : (
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: it.color }} aria-hidden />
          )}
          {it.label}
        </li>
      ))}
    </ul>
  );
}

/** One tooltip listing every series at the hovered position; values lead, labels follow */
export function ChartTooltip({
  x,
  width,
  top,
  title,
  rows,
}: {
  x: number;
  width: number;
  top: number;
  title: ReactNode;
  rows: { label: string; value: string; color?: string }[];
}) {
  const right = x > width / 2;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 min-w-36 max-w-64 rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-card"
      style={{ top, ...(right ? { right: width - x + 12 } : { left: x + 12 }) }}
    >
      <p className="mb-1 font-medium text-muted">{title}</p>
      <ul className="space-y-0.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2">
            {r.color ? (
              <span className="inline-block h-0.5 w-3 shrink-0 rounded-full" style={{ background: r.color }} aria-hidden />
            ) : null}
            <span className="font-semibold text-fg tabular">{r.value}</span>
            <span className="truncate text-muted">{r.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Stat tile: label · value · signed delta vs a named period. Delta color = direction × whether up is good,
 * always paired with an arrow glyph + text (never color alone).
 */
export function StatTile({
  label,
  value,
  delta,
  deltaLabel,
  upIsGood = true,
  sub,
  className,
}: {
  label: string;
  value: ReactNode;
  delta?: number | null;
  deltaLabel?: string;
  upIsGood?: boolean;
  sub?: ReactNode;
  className?: string;
}) {
  const hasDelta = delta !== undefined;
  const good = delta !== null && delta !== undefined && delta !== 0 && (delta > 0) === upIsGood;
  const bad = delta !== null && delta !== undefined && delta !== 0 && !good;
  return (
    <div className={cn('viz min-w-0 rounded-2xl border border-border bg-surface p-4 shadow-card', className)}>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 truncate text-xl font-semibold tracking-tight text-fg">{value}</p>
      {hasDelta ? (
        <p className="mt-0.5 flex items-center gap-1 text-xs">
          <span
            className="font-medium"
            style={{ color: good ? 'var(--viz-up)' : bad ? 'var(--viz-down)' : 'var(--muted)' }}
          >
            <span aria-hidden>{delta === null || delta === 0 ? '' : delta > 0 ? '▲ ' : '▼ '}</span>
            {formatDelta(delta)}
          </span>
          {deltaLabel ? <span className="text-subtle">{deltaLabel}</span> : null}
        </p>
      ) : null}
      {sub ? <p className="mt-0.5 truncate text-xs text-subtle">{sub}</p> : null}
    </div>
  );
}

/** Card with a chart ⇄ table toggle (every chart has a table-view twin) */
export function ChartCard({
  title,
  description,
  actions,
  chart,
  table,
  className,
  loading,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  chart: ReactNode;
  table?: ReactNode;
  className?: string;
  /** refetch in progress: keep the previous render at reduced opacity */
  loading?: boolean;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <Card className={cn('min-w-0', className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
          {description ? <p className="mt-0.5 text-[13px] text-muted">{description}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {table ? (
            <Segmented
              size="sm"
              label="表示形式"
              value={view}
              onChange={setView}
              options={[
                { value: 'chart', label: 'グラフ' },
                { value: 'table', label: '表' },
              ]}
            />
          ) : null}
        </div>
      </div>
      <div className={cn('transition-opacity', loading && 'opacity-60')}>
        {view === 'chart' || !table ? chart : table}
      </div>
    </Card>
  );
}
