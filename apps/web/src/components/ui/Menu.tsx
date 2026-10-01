import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Icon, type IconName } from './Icon';

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: IconName;
  onSelect: () => void;
  tone?: 'danger';
  checked?: boolean;
  disabled?: boolean;
  description?: ReactNode;
}

/** Dropdown menu button (menu button pattern: arrow keys, Escape, click-outside) */
export function Menu({
  trigger,
  items,
  label,
  align = 'right',
  header,
  className,
  triggerClassName,
}: {
  trigger: ReactNode;
  items: (MenuItem | 'separator')[];
  label: string;
  align?: 'left' | 'right';
  header?: ReactNode;
  className?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    const first = rootRef.current?.querySelector<HTMLElement>(
      '[role="menuitem"]:not([disabled]),[role="menuitemradio"]:not([disabled])',
    );
    first?.focus();
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    const els = [
      ...(rootRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([disabled]),[role="menuitemradio"]:not([disabled])',
      ) ?? []),
    ];
    const idx = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      btnRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      els[(idx + 1) % els.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      els[(idx - 1 + els.length) % els.length]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={cn('relative', className)} onKeyDown={open ? onKey : undefined}>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className={cn(
            'animate-fade-in absolute z-30 mt-1.5 min-w-[13rem] overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-card',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {header ? <div className="border-b border-border px-3 py-2">{header}</div> : null}
          {items.map((it, i) =>
            it === 'separator' ? (
              <div key={`sep-${i}`} role="separator" className="my-1 border-t border-border" />
            ) : (
              <button
                key={it.key}
                type="button"
                role={it.checked !== undefined ? 'menuitemradio' : 'menuitem'}
                aria-checked={it.checked}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] outline-none hover:bg-surface-2 focus:bg-surface-2 disabled:opacity-40',
                  it.tone === 'danger' ? 'text-danger' : 'text-fg',
                )}
              >
                {it.icon ? <Icon name={it.icon} size={16} className="shrink-0 text-muted" /> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{it.label}</span>
                  {it.description ? (
                    <span className="block truncate text-xs text-muted">{it.description}</span>
                  ) : null}
                </span>
                {it.checked ? <Icon name="check" size={16} className="text-primary" /> : null}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
