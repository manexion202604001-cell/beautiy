/**
 * shadcn/ui-style Popover (new-york), written for Tailwind 4: a trigger and a floating panel below
 * it. Closes on outside click and Escape. The panel is as wide as `w-72` unless `contentClassName`
 * says otherwise (`w-full` = the trigger's width, shadcn's `w-[var(--radix-popover-trigger-width)]`).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../../lib/cn';

export function Popover({
  trigger,
  children,
  contentClassName,
  align = 'center',
  label,
}: {
  /** the trigger element; spread `props` on the button that opens the panel */
  trigger: (props: {
    'aria-haspopup': 'dialog';
    'aria-expanded': boolean;
    'data-state': 'open' | 'closed';
    onClick: () => void;
  }) => ReactNode;
  children: ReactNode;
  contentClassName?: string;
  align?: 'start' | 'center' | 'end';
  /** accessible name of the panel */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger({
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'data-state': open ? 'open' : 'closed',
        onClick: () => setOpen((v) => !v),
      })}
      {open ? (
        <div
          role="dialog"
          aria-label={label}
          className={cx(
            'absolute top-full z-50 mt-1 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden',
            align === 'start' ? 'left-0' : align === 'end' ? 'right-0' : 'left-1/2 -translate-x-1/2',
            contentClassName,
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
