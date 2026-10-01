import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import './charts.css';
import { ChartTooltip, Legend, type LegendItem } from './parts';
import { compactNumber, labelStride, niceTicks, seriesColor, xLabelIndices } from './scale';
import { useWidth } from './useWidth';

export interface LineSeries {
  key: string;
  label: string;
  values: (number | null)[];
  /** 'muted' = de-emphasis gray (e.g. comparison period) */
  tone?: 'accent' | 'muted';
  color?: string;
  /** ~10% wash under the line (single primary series) */
  area?: boolean;
}

/**
 * Line chart with crosshair + tooltip (all series at the hovered x), optional confidence band,
 * keyboard navigation (←/→), legend for ≥ 2 series and a direct label at the last point.
 */
export function LineChart({
  labels,
  series,
  band,
  height = 240,
  xFormat = (k) => k,
  tooltipTitle,
  yFormat = compactNumber,
  valueFormat = (n) => n.toLocaleString('ja-JP'),
  ariaLabel,
}: {
  labels: string[];
  series: LineSeries[];
  band?: { lower: number[]; upper: number[]; label: string };
  height?: number;
  xFormat?: (key: string) => string;
  tooltipTitle?: (key: string) => string;
  yFormat?: (n: number) => string;
  valueFormat?: (n: number) => string;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const m = { top: 12, right: 20, bottom: 28, left: 56 };
  const plotW = Math.max(10, width - m.left - m.right);
  const plotH = height - m.top - m.bottom;
  const n = labels.length;

  const colorOf = (s: LineSeries, i: number) =>
    s.color ?? (s.tone === 'muted' ? 'var(--viz-muted-series)' : seriesColor(i));

  const { ticks, y } = useMemo(() => {
    const vals = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    if (band) vals.push(...band.upper, ...band.lower);
    const t = niceTicks(
      vals.length ? Math.min(...vals) : 0,
      vals.length ? Math.max(...vals) : 1,
      4,
      vals.every((v) => Number.isInteger(v)),
    );
    const lo = t[0]!;
    const hi = t[t.length - 1]!;
    return { ticks: t, y: (v: number) => m.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH };
  }, [series, band, plotH, m.top]);

  const x = (i: number) => m.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const shown = xLabelIndices(n, labelStride(n, plotW));

  const path = (values: (number | null)[]) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const idx = n <= 1 ? 0 : Math.round((px / rect.width) * (n - 1));
    setActive(Math.max(0, Math.min(n - 1, idx)));
  };
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

  const legend: LegendItem[] = series.map((s, i) => ({ label: s.label, color: colorOf(s, i), shape: 'line' }));
  if (band) legend.push({ label: band.label, color: 'var(--viz-band)', shape: 'rect' });
  const lastIdx = (vals: (number | null)[]) => {
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] !== null) return i;
    return -1;
  };
  const primary = series.findIndex((s) => s.tone !== 'muted');

  return (
    <div className="viz">
      {legend.length >= 2 ? <Legend items={legend} className="mb-2" /> : null}
      <div
        ref={ref}
        className="relative w-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-lg"
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
                strokeWidth={1}
              />
              <text
                x={m.left - 8}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                fontSize={11}
                fill="var(--viz-tick)"
                className="tabular"
              >
                {yFormat(t)}
              </text>
            </g>
          ))}
          {labels.map((l, i) =>
            shown.has(i) ? (
              <text
                key={l}
                x={x(i)}
                y={height - 8}
                textAnchor={n > 1 && i === 0 ? 'start' : n > 1 && i === n - 1 ? 'end' : 'middle'}
                fontSize={11}
                fill="var(--viz-tick)"
                className="tabular"
              >
                {xFormat(l)}
              </text>
            ) : null,
          )}
          {band ? (
            <path
              d={`${band.upper.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('')}${band.lower
                .map((v, i) => [i, v] as const)
                .reverse()
                .map(([i, v]) => `L${x(i)},${y(v)}`)
                .join('')}Z`}
              fill="var(--viz-band)"
            />
          ) : null}
          {series.map((s) =>
            s.area && n > 1 && lastIdx(s.values) >= 0 ? (
              <path
                key={`${s.key}-area`}
                d={`${path(s.values)}L${x(lastIdx(s.values))},${y(Math.max(0, ticks[0]!))}L${x(s.values.findIndex((v) => v !== null))},${y(Math.max(0, ticks[0]!))}Z`}
                fill="var(--viz-area)"
              />
            ) : null,
          )}
          {/* muted series first so the accent line sits on top */}
          {[...series.map((s, i) => [s, i] as const)]
            .sort(([a], [b]) => (a.tone === 'muted' ? 0 : 1) - (b.tone === 'muted' ? 0 : 1))
            .map(([s, i]) => (
              <path
                key={s.key}
                d={path(s.values)}
                fill="none"
                stroke={colorOf(s, i)}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                className="viz-mark"
              />
            ))}
          {n === 1
            ? series.map((s, i) =>
                s.values[0] !== null ? (
                  <circle key={s.key} cx={x(0)} cy={y(s.values[0]!)} r={4} fill={colorOf(s, i)} stroke="var(--viz-surface)" strokeWidth={2} />
                ) : null,
              )
            : null}
          {primary >= 0 && active === null
            ? (() => {
                const s = series[primary]!;
                const li = lastIdx(s.values);
                if (li < 0) return null;
                return (
                  <circle
                    cx={x(li)}
                    cy={y(s.values[li]!)}
                    r={4}
                    fill={colorOf(s, primary)}
                    stroke="var(--viz-surface)"
                    strokeWidth={2}
                  />
                );
              })()
            : null}
          {active !== null ? (
            <g pointerEvents="none">
              <line x1={x(active)} x2={x(active)} y1={m.top} y2={m.top + plotH} stroke="var(--viz-axis)" strokeWidth={1} />
              {series.map((s, i) =>
                s.values[active] !== null && s.values[active] !== undefined ? (
                  <circle
                    key={s.key}
                    cx={x(active)}
                    cy={y(s.values[active]!)}
                    r={4.5}
                    fill={colorOf(s, i)}
                    stroke="var(--viz-surface)"
                    strokeWidth={2}
                  />
                ) : null,
              )}
            </g>
          ) : null}
          <rect
            x={m.left}
            y={m.top}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerDown={onMove}
            onPointerLeave={() => setActive(null)}
          />
        </svg>
        {active !== null && labels[active] !== undefined ? (
          <ChartTooltip
            x={x(active)}
            width={width}
            top={m.top}
            title={(tooltipTitle ?? xFormat)(labels[active])}
            rows={[
              ...series.map((s, i) => ({
                label: s.label,
                color: colorOf(s, i),
                value: s.values[active] === null || s.values[active] === undefined ? '—' : valueFormat(s.values[active]!),
              })),
              ...(band
                ? [
                    {
                      label: band.label,
                      color: 'var(--viz-band)',
                      value: `${valueFormat(band.lower[active] ?? 0)} 〜 ${valueFormat(band.upper[active] ?? 0)}`,
                    },
                  ]
                : []),
            ]}
          />
        ) : null}
      </div>
    </div>
  );
}
