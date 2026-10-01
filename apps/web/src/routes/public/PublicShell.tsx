import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Mobile-first frame for customer pages (works in the LINE in-app browser) */
export function PublicShell({
  children,
  header,
  footer,
  className,
}: {
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div className="min-h-[100dvh] bg-bg">
      {header}
      <main className={cn('mx-auto w-full max-w-xl px-4 pb-32 pt-4', className)}>{children}</main>
      {footer}
      <p className="pb-6 text-center text-[11px] text-subtle">Powered by Salon OS</p>
    </div>
  );
}

export function ShopHeader({
  name,
  sub,
  right,
}: {
  name: string;
  sub?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-xl items-center gap-3 px-4 py-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-base font-bold text-primary-fg"
          aria-hidden
        >
          {name.replace(/\s+/g, '').slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-fg">{name}</p>
          {sub ? <div className="truncate text-xs text-muted">{sub}</div> : null}
        </div>
        {right}
      </div>
    </header>
  );
}
