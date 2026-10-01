import { useId, useRef, type KeyboardEvent } from 'react';
import { cn } from '../../lib/cn';

const STAR = 'm12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z';

/** Read-only star rating (supports fractional averages) */
export function Stars({
  value,
  size = 16,
  className,
}: {
  value: number | null;
  size?: number;
  className?: string;
}) {
  const id = useId();
  const v = Math.max(0, Math.min(5, value ?? 0));
  return (
    <span
      className={cn('inline-flex items-center gap-0.5 text-[#f5a623]', className)}
      role="img"
      aria-label={value === null ? '評価なし' : `5点中${Math.round(v * 10) / 10}点`}
    >
      {[0, 1, 2, 3, 4].map((i) => {
        const fill = Math.max(0, Math.min(1, v - i));
        const gid = `${id}-${i}`;
        return (
          <svg key={i} width={size} height={size} viewBox="0 0 24 24" aria-hidden>
            <defs>
              <linearGradient id={gid}>
                <stop offset={`${fill * 100}%`} stopColor="currentColor" />
                <stop offset={`${fill * 100}%`} stopColor="var(--surface-3)" />
              </linearGradient>
            </defs>
            <path
              d={STAR}
              fill={`url(#${gid})`}
              stroke="currentColor"
              strokeWidth={fill > 0 ? 0 : 1}
              strokeOpacity={0.35}
            />
          </svg>
        );
      })}
    </span>
  );
}

/** Accessible star input (radiogroup; arrow keys change the value) */
export function StarInput({
  value,
  onChange,
  label,
  size = 40,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
  size?: number;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent) => {
    let next: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(5, (value || 0) + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(1, (value || 2) - 1);
    else return;
    e.preventDefault();
    onChange(next);
    refs.current[next - 1]?.focus();
  };
  const words = ['', 'とても不満', '不満', 'ふつう', '満足', 'とても満足'];
  return (
    <div>
      <div role="radiogroup" aria-label={label} className="flex gap-1" onKeyDown={onKey}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            ref={(el) => {
              refs.current[n - 1] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n}点（${words[n]}）`}
            tabIndex={value === n || (!value && n === 1) ? 0 : -1}
            onClick={() => onChange(n)}
            className="rounded-md p-0.5 transition-transform active:scale-90"
          >
            <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
              <path
                d={STAR}
                fill={n <= value ? '#f5a623' : 'var(--surface-3)'}
                stroke={n <= value ? '#f5a623' : 'var(--border-strong)'}
                strokeWidth={1}
              />
            </svg>
          </button>
        ))}
      </div>
      <p className="mt-1 h-5 text-[13px] text-muted" aria-live="polite">
        {value ? words[value] : ''}
      </p>
    </div>
  );
}

/** Rating distribution bars (5 → 1) */
export function RatingBars({
  distribution,
  count,
}: {
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
  count: number;
}) {
  return (
    <ul className="space-y-1">
      {(['5', '4', '3', '2', '1'] as const).map((k) => {
        const n = distribution[k] ?? 0;
        const pct = count ? Math.round((n / count) * 100) : 0;
        return (
          <li key={k} className="flex items-center gap-2 text-xs">
            <span className="w-6 shrink-0 text-muted tabular">★{k}</span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
              <span
                className="block h-full rounded-full bg-[#f5a623]"
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="w-14 shrink-0 text-right text-muted tabular">
              {n}件<span className="sr-only">（{pct}%）</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
