import { useMemo, useState, type KeyboardEvent } from 'react';
import { cn } from '../../lib/cn';
import './charts.css';
import { ChartTooltip, Legend } from './parts';
import { compactNumber, labelStride, niceTicks, seriesColor, xLabelIndices } from './scale';
import { useWidth } from './useWidth';

/** Column path: 4px rounded data end, square at the baseline (handles negative values) */
function columnPath(x: number, y0: number, y1: number, w: number) {
  const top = Math.min(y0, y1);
  const h = Math.abs(y1 - y0);
  const r = Math.min(4, w / 2, h);
  if (h <= 0.5) return '';
  if (y1 <= y0) {
    // positive: rounded top
    return `M${x},${top + h}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${top + h}Z`;
  }
  // negative: rounded bottom
  return `M${x},${top}V${top + h - r}Q${x},${top + h} ${x + r},${top + h}H${x + w - r}Q${x + w},${top + h} ${x + w},${top + h - r}V${top}Z`;
}

export interface ColumnSeries {
  key: string;
  label: string;
  values: number[];
  tone?: 'accent' | 'muted';
  color?: string;
}

/**
 * Vertical columns (one or a few series side by side). Bars ≤ 24px, 2px surface gap between
 * adjacent bars, per-band hover/focus tooltip listing every series.
 */
export function ColumnChart({
  labels,
  series,
  height = 240,
  xFormat = (k) => k,
  tooltipTitle,
  yFormat = compactNumber,
  valueFormat = (n) => n.toLocaleString('ja-JP'),
  ariaLabel,
}: {
  labels: string[];
  series: ColumnSeries[];
  height?: number;
  xFormat?: (k: string) => string;
  tooltipTitle?: (k: string) => string;
  yFormat?: (n: number) => string;
  valueFormat?: (n: number) => string;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const m = { top: 12, right: 12, bottom: 28, left: 56 };
  const plotW = Math.max(10, width - m.left - m.right);
  const plotH = height - m.top - m.bottom;
  const n = labels.length;
  const colorOf = (s: ColumnSeries, i: number) =>
    s.color ?? (s.tone === 'muted' ? 'var(--viz-muted-series)' : seriesColor(i));

  const { ticks, y } = useMemo(() => {
    const vals = series.flatMap((s) => s.values);
    const t = niceTicks(
      vals.length ? Math.min(...vals) : 0,
      vals.length ? Math.max(...vals) : 1,
      4,
      vals.every((v) => Number.isInteger(v)),
    );
    const lo = t[0]!;
    const hi = t[t.length - 1]!;
    return { ticks: t, y: (v: number) => m.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH };
  }, [series, plotH, m.top]);

  const band = n ? plotW / n : plotW;
  const gap = 2;
  const k = Math.max(1, series.length);
  const barW = Math.max(2, Math.min(24, (band * 0.7 - gap * (k - 1)) / k));
  const groupW = barW * k + gap * (k - 1);
  const shown = xLabelIndices(n, labelStride(n, plotW));

  const onKey = (e: KeyboardEvent) => {
    if (!n) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setActive((a) => {
        const cur = a ?? (e.key === 'ArrowRight' ? -1 : n);
        return Math.max(0, Math.min(n - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)));
      });
    } else if (e.key === 'Escape') setActive(null);
  };

  return (
    <div className="viz">
      {series.length >= 2 ? (
        <Legend className="mb-2" items={series.map((s, i) => ({ label: s.label, color: colorOf(s, i) }))} />
      ) : null}
      <div
        ref={ref}
        className="relative w-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        tabIndex={0}
        role="group"
        aria-label={`${ariaLabel}（←→キーで値を表示）`}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={m.left}
                x2={m.left + plotW}
                y1={y(t)}
                y2={y(t)}
                stroke={t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'}
              />
              <text x={m.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--viz-tick)" className="tabular">
                {yFormat(t)}
              </text>
            </g>
          ))}
          {labels.map((l, i) => {
            const gx = m.left + i * band + (band - groupW) / 2;
            return (
              <g key={l} onPointerEnter={() => setActive(i)} onPointerLeave={() => setActive(null)}>
                {/* hit target = whole band */}
                <rect x={m.left + i * band} y={m.top} width={band} height={plotH} fill="transparent" />
                {series.map((s, si) => (
                  <path
                    key={s.key}
                    d={columnPath(gx + si * (barW + gap), y(0), y(s.values[i] ?? 0), barW)}
                    fill={colorOf(s, si)}
                    className="viz-mark"
                    data-dim={active !== null && active !== i ? 'true' : undefined}
                  />
                ))}
                {shown.has(i) ? (
                  <text x={m.left + i * band + band / 2} y={height - 8} textAnchor="middle" fontSize={11} fill="var(--viz-tick)" className="tabular">
                    {xFormat(l)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        {active !== null && labels[active] !== undefined ? (
          <ChartTooltip
            x={m.left + active * band + band / 2}
            width={width}
            top={m.top}
            title={(tooltipTitle ?? xFormat)(labels[active])}
            rows={series.map((s, si) => ({ label: s.label, color: colorOf(s, si), value: valueFormat(s.values[active] ?? 0) }))}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Horizontal ranking bars (HTML): label · bar (≤ 14px, 4px rounded end) · value at the tip.
 * Every value is printed, so no tooltip is needed; an optional comparison marker shows the previous value.
 */
export function BarList({
  rows,
  valueFormat = (n) => n.toLocaleString('ja-JP'),
  color = 'var(--viz-1)',
  ariaLabel,
  className,
}: {
  rows: { key: string; label: string; value: number; sub?: string; href?: string }[];
  valueFormat?: (n: number) => string;
  color?: string;
  ariaLabel: string;
  className?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  if (!rows.length) return <p className="text-[13px] text-muted">この期間のデータはありません。</p>;
  return (
    <ul className={cn('viz space-y-2.5', className)} aria-label={ariaLabel}>
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(6rem,10rem)_1fr] items-center gap-3 text-[13px] sm:grid-cols-[minmax(8rem,12rem)_1fr]">
          <div className="min-w-0">
            <p className="truncate text-fg" title={r.label}>
              {r.label}
            </p>
            {r.sub ? <p className="truncate text-xs text-subtle">{r.sub}</p> : null}
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <div className="h-3.5 min-w-0 flex-1">
              <div
                className="viz-mark h-full rounded-r"
                style={{ width: r.value === 0 ? 0 : `${Math.max(1, (Math.abs(r.value) / max) * 100)}%`, background: color }}
              />
            </div>
            <span className="w-24 shrink-0 text-right font-medium text-fg tabular">{valueFormat(r.value)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * 100% stacked share bar (part-to-whole, ≤ 6 parts + その他). 2px surface gaps between segments,
 * legend with values below (identity never color-alone).
 */
export function ShareBar({
  parts,
  valueFormat = (n) => n.toLocaleString('ja-JP'),
  ariaLabel,
  maxParts = 6,
}: {
  parts: { key: string; label: string; value: number }[];
  valueFormat?: (n: number) => string;
  ariaLabel: string;
  maxParts?: number;
}) {
  const sorted = [...parts].filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, maxParts);
  const tail = sorted.slice(maxParts);
  const items = tail.length
    ? [...head, { key: '__other', label: 'その他', value: tail.reduce((s, p) => s + p.value, 0) }]
    : head;
  const total = items.reduce((s, p) => s + p.value, 0);
  const [hover, setHover] = useState<string | null>(null);
  if (!total) return <p className="text-[13px] text-muted">データがありません</p>;
  const colorFor = (key: string, i: number) => (key === '__other' ? 'var(--viz-other)' : seriesColor(i));
  return (
    <div className="viz">
      <div className="flex h-4 w-full gap-[2px] overflow-hidden rounded" role="img" aria-label={ariaLabel}>
        {items.map((p, i) => (
          <div
            key={p.key}
            className="viz-mark h-full first:rounded-l last:rounded-r"
            style={{ width: `${(p.value / total) * 100}%`, background: colorFor(p.key, i) }}
            data-dim={hover && hover !== p.key ? 'true' : undefined}
            title={`${p.label}: ${valueFormat(p.value)}（${((p.value / total) * 100).toFixed(1)}%）`}
            onPointerEnter={() => setHover(p.key)}
            onPointerLeave={() => setHover(null)}
          />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
        {items.map((p, i) => (
          <li
            key={p.key}
            className="flex items-center gap-2"
            onPointerEnter={() => setHover(p.key)}
            onPointerLeave={() => setHover(null)}
          >
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colorFor(p.key, i) }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-fg">{p.label}</span>
            <span className="text-muted tabular">{((p.value / total) * 100).toFixed(1)}%</span>
            <span className="w-24 text-right font-medium text-fg tabular">{valueFormat(p.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
