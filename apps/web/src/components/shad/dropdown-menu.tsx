/**
 * shadcn/ui-style DropdownMenu (new-york), written for Tailwind 4, with composable content:
 * MenuLabel / MenuSeparator / MenuItem / MenuLink inside <Menu>. (The `DropdownMenu` in index.tsx
 * takes a flat item list; use this one when the menu has a heading, separators or links.)
 * Closes on outside click, Escape and after an item is chosen.
 */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';
import { cx } from '../../lib/cn';

const CloseContext = createContext<() => void>(() => undefined);

export function Menu({
  trigger,
  triggerClassName,
  label,
  side = 'bottom',
  align = 'start',
  contentClassName,
  disabled,
  children,
}: {
  trigger: ReactNode;
  triggerClassName?: string;
  /** the trigger does not open the menu (e.g. nothing to choose from) */
  disabled?: boolean;
  /** accessible name of the trigger button */
  label?: string;
  side?: 'bottom' | 'top';
  align?: 'start' | 'end';
  contentClassName?: string;
  children: ReactNode;
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
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        data-state={open ? 'open' : 'closed'}
        disabled={disabled}
        className={triggerClassName}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open ? (
        <div
          role="menu"
          className={cx(
            'absolute z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
            side === 'bottom' ? 'top-full mt-1' : 'bottom-full mb-1',
            align === 'start' ? 'left-0' : 'right-0',
            contentClassName,
          )}
        >
          <CloseContext.Provider value={() => setOpen(false)}>{children}</CloseContext.Provider>
        </div>
      ) : null}
    </div>
  );
}

const ITEM =
  'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground [&>svg]:size-4 [&>svg]:shrink-0';

export function MenuItem({
  onSelect,
  className,
  children,
}: {
  onSelect: () => void;
  className?: string;
  children: ReactNode;
}) {
  const close = useContext(CloseContext);
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      className={cx(ITEM, className)}
      onClick={() => {
        close();
        onSelect();
      }}
    >
      {children}
    </div>
  );
}

/** A menu item that is a link (shadcn's `<DropdownMenuItem asChild><Link/></DropdownMenuItem>`) */
export function MenuLink({
  to,
  className,
  children,
}: {
  to: string;
  className?: string;
  children: ReactNode;
}) {
  const close = useContext(CloseContext);
  return (
    <Link role="menuitem" to={to} className={cx(ITEM, className)} onClick={close}>
      {children}
    </Link>
  );
}

export function MenuLabel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('px-2 py-1.5 text-sm font-semibold', className)} {...rest} />;
}

export function MenuSeparator({ className }: { className?: string }) {
  return <div role="separator" className={cx('-mx-1 my-1 h-px bg-muted', className)} />;
}
