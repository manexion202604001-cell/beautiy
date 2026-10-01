import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'outline';

const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted border-border',
  primary: 'bg-primary-soft text-primary border-transparent',
  success: 'bg-success-soft text-success border-transparent',
  warning: 'bg-warning-soft text-warning border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  info: 'bg-info-soft text-info border-transparent',
  outline: 'bg-transparent text-muted border-border-strong',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
  dot,
  size = 'md',
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
  size?: 'sm' | 'md';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border font-medium',
        size === 'sm' ? 'px-1.5 py-0 text-[11px] leading-[18px]' : 'px-2 py-0.5 text-xs',
        tones[tone],
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  );
}

/** Colored tag chip (customer tags) */
export function TagChip({
  name,
  color,
  onRemove,
}: {
  name: string;
  color: string;
  onRemove?: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-fg">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} aria-hidden />
      {name}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="-mr-0.5 ml-0.5 rounded-full px-1 text-muted hover:text-fg"
          aria-label={`${name}を外す`}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
