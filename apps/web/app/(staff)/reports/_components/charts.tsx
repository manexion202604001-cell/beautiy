// Inline-SVG charts (server components, no chart library). Hover tooltips use <title>
// on a full-height hit band; every chart has an accessible label and a table view.
import type { ReactNode } from 'react';
import { yen, yenShort } from '@/lib/format';

/** Categorical slots in fixed order (validated palette); never cycled past 4 — fold into "その他". */
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'];

export interface ChartSeries { key: string; label: string; color: string; values: number[] }

function niceStep(max: number, ticks = 4) {
  if (max <= 0) return 1;
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
}

/** Rounded-top column path anchored on the baseline (negative values round the bottom). */
function colPath(x: number, w: number, y0: number, y1: number) {
  const h = Math.abs(y1 - y0);
  const r = Math.min(4, w / 2, h);
  if (h < 0.5) return '';
  if (y1 < y0) return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

export function ColumnChart({
  labels, tipLabels, series, ariaLabel, format = yen, axisFormat = yenShort, height = 250, table = true, tableHead, width = 920,
}: {
  labels: string[]; tipLabels?: string[]; series: ChartSeries[]; ariaLabel: string;
  format?: (n: number) => string; axisFormat?: (n: number) => string; height?: number; table?: boolean; tableHead?: string;
  /** viewBox width: use ~480 for half-width cards so text renders at its nominal size */
  width?: number;
}) {
  const W = width, H = height, padL = 58, padR = 10, padT = 12, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const all = series.flatMap((s) => s.values);
  const maxV = Math.max(0, ...all), minV = Math.min(0, ...all);
  const step = niceStep(Math.max(maxV - minV, 1));
  const top = Math.ceil(maxV / step) * step || step, bottom = Math.floor(minV / step) * step;
  const y = (v: number) => padT + plotH * (1 - (v - bottom) / (top - bottom || 1));
  const n = labels.length || 1;
  const band = plotW / n;
  const groupW = Math.min(band * 0.72, series.length * 24 + (series.length - 1) * 2);
  const barW = Math.max(1, (groupW - (series.length - 1) * 2) / series.length);
  const every = Math.max(1, Math.ceil(n / 12));
  const ticks: number[] = [];
  for (let v = bottom; v <= top + 1e-9; v += step) ticks.push(v);
  const empty = all.every((v) => v === 0);

  return (
    <figure className="viz">
      {series.length > 1 && (
        <div className="viz-legend" aria-hidden="true">
          {series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}
        </div>
      )}
      <div className="viz-scroll"><svg viewBox={`0 0 ${W} ${H}`} className="viz-svg" role="img" aria-label={ariaLabel} style={{ minWidth: Math.round(W * 0.65) }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-base' : 'viz-grid'} />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" className="viz-axis">{axisFormat(t)}</text>
          </g>
        ))}
        {labels.map((l, i) => {
          const x0 = padL + band * i;
          const gx = x0 + (band - groupW) / 2;
          const tip = `${tipLabels?.[i] ?? l}\n${series.map((s) => `${s.label}: ${format(s.values[i] ?? 0)}`).join('\n')}`;
          return (
            <g key={i} className="viz-band">
              <title>{tip}</title>
              <rect x={x0} y={padT} width={band} height={plotH} className="viz-hit" />
              {series.map((s, si) => {
                const v = s.values[i] ?? 0;
                const d = colPath(gx + si * (barW + 2), barW, y(0), y(v));
                return d ? <path key={s.key} d={d} fill={s.color} className="viz-bar" /> : null;
              })}
              {i % every === 0 && <text x={x0 + band / 2} y={H - 10} textAnchor="middle" className="viz-axis">{l}</text>}
            </g>
          );
        })}
        {empty && <text x={padL + plotW / 2} y={padT + plotH / 2} textAnchor="middle" className="viz-empty">この期間のデータはありません</text>}
      </svg></div>
      {table && (
        <details className="viz-table">
          <summary>表で見る</summary>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{tableHead ?? '期間'}</th>{series.map((s) => <th key={s.key} className="num">{s.label}</th>)}</tr></thead>
              <tbody>
                {labels.map((l, i) => (
                  <tr key={i}><td>{tipLabels?.[i] ?? l}</td>{series.map((s) => <td key={s.key} className="num">{format(s.values[i] ?? 0)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}

/** One 100% bar split into parts (2px surface gaps) + legend with values and shares. */
export function SplitBar({ parts, format = yen, ariaLabel }: { parts: { label: string; value: number; color: string }[]; format?: (n: number) => string; ariaLabel: string }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  return (
    <div className="split-viz">
      <div className="split-track" role="img" aria-label={`${ariaLabel}: ${parts.map((p) => `${p.label} ${format(p.value)}`).join('、')}`}>
        {total > 0 ? parts.filter((p) => p.value > 0).map((p) => (
          <span key={p.label} style={{ flexGrow: p.value, background: p.color }} title={`${p.label}: ${format(p.value)}（${((p.value / total) * 100).toFixed(1)}%）`} />
        )) : <span style={{ flexGrow: 1, background: 'var(--gray-soft)' }} />}
      </div>
      <ul className="split-legend">
        {parts.map((p) => (
          <li key={p.label}>
            <i style={{ background: p.color }} />
            <span className="grow">{p.label}</span>
            <b className="num">{format(p.value)}</b>
            <span className="sub num">{total ? `${((Math.max(0, p.value) / total) * 100).toFixed(1)}%` : '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Horizontal bars for ranked/binned lists. */
export function HBarList({ rows, format = (n: number) => n.toLocaleString('ja-JP'), ariaLabel, color = SERIES_COLORS[0] }: { rows: { label: ReactNode; value: number; sub?: ReactNode; key: string }[]; format?: (n: number) => string; ariaLabel: string; color?: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <ul className="hbar-list" aria-label={ariaLabel}>
      {rows.map((r) => (
        <li key={r.key}>
          <div className="hbar-label">{r.label}</div>
          <div className="hbar-track" title={`${typeof r.label === 'string' ? r.label : ''} ${format(r.value)}`}>
            <span style={{ width: max > 0 ? `${Math.max(r.value > 0 ? 1.5 : 0, (r.value / max) * 100)}%` : 0, background: color }} />
          </div>
          <div className="hbar-value num">{format(r.value)}{r.sub && <span className="sub"> {r.sub}</span>}</div>
        </li>
      ))}
    </ul>
  );
}

export function Delta({ cur, prev, suffix = '前期間比' }: { cur: number; prev: number; suffix?: string }) {
  if (!prev) return <span className="sub">{suffix} —</span>;
  const d = (cur - prev) / Math.abs(prev);
  const up = d >= 0;
  return <span className={`delta ${up ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {(Math.abs(d) * 100).toFixed(1)}% <span className="sub">{suffix}</span></span>;
}
