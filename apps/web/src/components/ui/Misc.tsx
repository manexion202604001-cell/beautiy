import type { ReactNode } from 'react';
import { errorMessage, isApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { Spinner } from './Spinner';

export function Card({
  children,
  className,
  padded = true,
  as: As = 'section',
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  as?: 'section' | 'div' | 'article';
}) {
  return (
    <As
      className={cn(
        'rounded-2xl border border-border bg-surface shadow-card',
        padded && 'p-5',
        className,
      )}
    >
      {children}
    </As>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-4 flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
        {description ? <p className="mt-0.5 text-[13px] text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {back ? <div className="mb-1">{back}</div> : null}
        <h1 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">{title}</h1>
        {description ? <p className="mt-1 text-[13px] text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({
  icon = 'sparkle',
  title,
  description,
  action,
  className,
}: {
  icon?: IconName;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-2xl border border-dashed border-border px-6 py-10 text-center',
        className,
      )}
    >
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-primary-soft text-primary">
        <Icon name={icon} size={22} />
      </div>
      <p className="text-sm font-medium text-fg">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-[13px] text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const forbidden = isApiError(error) && error.category === 'authorization';
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center rounded-2xl border border-border bg-surface px-6 py-10 text-center',
        className,
      )}
    >
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-danger-soft text-danger">
        <Icon name={forbidden ? 'lock' : 'alert'} size={22} />
      </div>
      <p className="text-sm font-medium text-fg">
        {forbidden ? 'この画面を表示する権限がありません' : '読み込みに失敗しました'}
      </p>
      <p className="mt-1 max-w-md text-[13px] text-muted">{errorMessage(error)}</p>
      {onRetry && !forbidden ? (
        <Button className="mt-4" size="sm" icon="refresh" onClick={onRetry}>
          再読み込み
        </Button>
      ) : null}
    </div>
  );
}

/** Inline alert box */
export function Alert({
  tone = 'info',
  title,
  children,
  className,
  action,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  const toneCls = {
    info: 'bg-info-soft text-info',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
    success: 'bg-success-soft text-success',
  }[tone];
  const icon: IconName = tone === 'success' ? 'check' : tone === 'info' ? 'info' : 'alert';
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex items-start gap-3 rounded-xl px-4 py-3 text-[13px]', toneCls, className)}
    >
      <Icon name={icon} size={18} className="mt-px shrink-0" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="mt-0.5 text-fg">{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

/** Cursor pagination footer ("もっと見る") */
export function LoadMore({
  hasMore,
  loading,
  onClick,
  total,
}: {
  hasMore: boolean;
  loading: boolean;
  onClick: () => void;
  total?: number;
}) {
  if (!hasMore) {
    return total !== undefined && total > 0 ? (
      <p className="py-4 text-center text-xs text-subtle">全{total}件を表示しています</p>
    ) : null;
  }
  return (
    <div className="flex justify-center py-4">
      <Button variant="secondary" onClick={onClick} loading={loading} iconRight="chevron-down">
        もっと見る
      </Button>
    </div>
  );
}

export function Avatar({
  name,
  color,
  size = 32,
  className,
}: {
  name: string | null | undefined;
  color?: string | null;
  size?: number;
  className?: string;
}) {
  const ch = (name ?? '?').replace(/\s+/g, '').slice(0, 1) || '?';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white',
        className,
      )}
      style={{
        width: size,
        height: size,
        background: color ?? 'var(--primary)',
        fontSize: Math.round(size * 0.42),
      }}
      aria-hidden
    >
      {ch}
    </span>
  );
}

export function Stat({
  label,
  value,
  sub,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 truncate text-lg font-semibold text-fg tabular">{value}</p>
      {sub ? <p className="truncate text-xs text-subtle">{sub}</p> : null}
    </div>
  );
}

export function InlineLoading({ label = '読み込み中…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-[13px] text-muted" role="status">
      <Spinner />
      {label}
    </div>
  );
}

export function KeyValue({
  items,
  className,
}: {
  items: { label: ReactNode; value: ReactNode }[];
  className?: string;
}) {
  return (
    <dl
      className={cn(
        'grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-2 text-[13px]',
        className,
      )}
    >
      {items.map((it, i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{it.label}</dt>
          <dd className="min-w-0 break-words text-fg">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
