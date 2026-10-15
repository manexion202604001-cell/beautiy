/**
 * shadcn/ui-style primitives (new-york). Class lists follow the shadcn defaults, written for
 * Tailwind 4 (v3 `shadow` = v4 `shadow-sm`, `shadow-sm` = `shadow-xs`, `outline-none` = `outline-hidden`).
 * CardContent uses p-2 instead of p-6 to match the screens these are modelled on.
 */
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cx as cn } from '../../lib/cn';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0';

const BUTTON_VARIANTS = {
  default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
  destructive: 'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90',
  outline: 'border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground',
  secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  link: 'text-primary underline-offset-4 hover:underline',
} as const;

const BUTTON_SIZES = {
  default: 'h-9 px-4 py-2',
  sm: 'h-8 rounded-md px-3 text-xs',
  lg: 'h-10 rounded-md px-8',
  icon: 'h-9 w-9',
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;
export type ButtonSize = keyof typeof BUTTON_SIZES;

export function buttonVariants(
  variant: ButtonVariant = 'default',
  size: ButtonSize = 'default',
  className?: string,
) {
  return cn(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={buttonVariants(variant, size, className)} {...rest} />
  );
});

type DivProps = HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...rest }: DivProps) {
  return (
    <div
      className={cn('rounded-xl border bg-card text-card-foreground shadow-sm', className)}
      {...rest}
    />
  );
}
export function CardHeader({ className, ...rest }: DivProps) {
  return <div className={cn('flex flex-col sy-1.5 p-6', className)} {...rest} />;
}
export function CardTitle({ className, ...rest }: DivProps) {
  return <div className={cn('font-semibold leading-none tracking-tight', className)} {...rest} />;
}
export function CardDescription({ className, ...rest }: DivProps) {
  return <div className={cn('text-sm text-muted-foreground', className)} {...rest} />;
}
export function CardContent({ className, ...rest }: DivProps) {
  return <div className={cn('p-2 pt-0', className)} {...rest} />;
}

const BADGE_BASE =
  'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2';

const BADGE_VARIANTS = {
  default: 'border-transparent bg-primary text-primary-foreground shadow-sm hover:bg-primary/80',
  secondary: 'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
  destructive:
    'border-transparent bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/80',
  outline: 'text-foreground',
  success: 'border-transparent bg-green-500 text-white shadow-sm hover:bg-green-500/80',
  warning: 'border-transparent bg-yellow-500 text-white shadow-sm hover:bg-yellow-500/80',
} as const;

export type BadgeVariant = keyof typeof BADGE_VARIANTS;

export function Badge({
  variant = 'default',
  className,
  ...rest
}: DivProps & { variant?: BadgeVariant }) {
  return <div className={cn(BADGE_BASE, BADGE_VARIANTS[variant], className)} {...rest} />;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, type, ...rest }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          className,
        )}
        {...rest}
      />
    );
  },
);

export function Label({ className, ...rest }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn(
        'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        className,
      )}
      {...rest}
    />
  );
}

export function Separator({ className }: { className?: string }) {
  return <div role="none" className={cn('h-[1px] w-full shrink-0 bg-border', className)} />;
}

export interface DropdownItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  /** small note shown at the right edge */
  trailing?: ReactNode;
  active?: boolean;
  onSelect: () => void;
}

/** Dropdown menu: trigger button + popover list (role=menu), closes on outside click / Escape */
export function DropdownMenu({
  trigger,
  triggerClassName,
  label,
  items,
  contentClassName,
  side = 'bottom',
  align = 'start',
}: {
  trigger: ReactNode;
  triggerClassName?: string;
  label?: string;
  items: DropdownItem[];
  contentClassName?: string;
  side?: 'bottom' | 'top';
  align?: 'start' | 'end';
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
        className={triggerClassName}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open ? (
        <div
          role="menu"
          className={cn(
            'absolute z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
            side === 'bottom' ? 'top-full mt-1' : 'bottom-full mb-1',
            align === 'start' ? 'left-0' : 'right-0',
            contentClassName,
          )}
        >
          {items.map((it) => (
            <div
              key={it.key}
              role="menuitem"
              tabIndex={-1}
              className={cn(
                'relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground [&>svg]:size-4 [&>svg]:shrink-0',
                it.active && 'bg-accent',
              )}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.icon}
              <span className="truncate">{it.label}</span>
              {it.trailing ? (
                <span className="ml-auto text-xs text-muted-foreground">{it.trailing}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Product wordmark, same typography as the system it replaces (Montserrat 700, two-tone) */
export function Wordmark() {
  return (
    <>
      <span style={{ fontFamily: 'var(--font-logo)', fontWeight: 700, color: '#1a1a1a' }}>
        SALON
      </span>
      <span style={{ fontFamily: 'var(--font-logo)', fontWeight: 700, color: 'var(--primary)' }}> OS</span>
    </>
  );
}

/** Segmented tabs (role=tablist); the active tab is a white pill on the muted track */
export function Tabs<T extends string>({
  value,
  onValueChange,
  items,
  className,
  listClassName,
  triggerClassName,
  label,
}: {
  value: T;
  onValueChange: (v: T) => void;
  items: { value: T; label: ReactNode }[];
  className?: string;
  listClassName?: string;
  triggerClassName?: string;
  label?: string;
}) {
  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label={label}
        className={cn(
          'inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground',
          listClassName,
        )}
      >
        {items.map((it) => (
          <button
            key={it.value}
            type="button"
            role="tab"
            aria-selected={it.value === value}
            data-state={it.value === value ? 'active' : 'inactive'}
            onClick={() => onValueChange(it.value)}
            className={cn(
              'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
              triggerClassName,
            )}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Select: combobox button + option list, closes on outside click / Escape */
export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  className,
  label,
}: {
  value: string;
  onValueChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  className?: string;
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
  const current = options.find((o) => o.value === value);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-label={label}
        data-state={open ? 'open' : 'closed'}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs ring-offset-background placeholder:text-muted-foreground focus:outline-hidden focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1',
          className,
        )}
      >
        <span style={{ pointerEvents: 'none' }}>{current?.label ?? placeholder}</span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="lucide lucide-chevron-down h-4 w-4 opacity-50"
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <div
          role="listbox"
          className="absolute left-0 top-full z-50 mt-1 max-h-96 min-w-full overflow-y-auto overflow-x-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          <div className="p-1">
            {options.map((o) => (
              <div
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                onClick={() => {
                  setOpen(false);
                  onValueChange(o.value);
                }}
                className="relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-hidden hover:bg-accent hover:text-accent-foreground"
              >
                <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
                  {o.value === value ? (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="lucide lucide-check h-4 w-4"
                      aria-hidden
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  ) : null}
                </span>
                <span>{o.label}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Round avatar: photo when available, otherwise the first character on the muted circle */
export function Avatar({
  name,
  src,
  className,
  fallbackClassName,
}: {
  name: string;
  src?: string | null;
  className?: string;
  fallbackClassName?: string;
}) {
  return (
    <span className={cn('relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full', className)}>
      {src ? (
        <img src={src} alt="" className="aspect-square h-full w-full object-cover" />
      ) : (
        <span
          className={cn(
            'flex h-full w-full items-center justify-center rounded-full bg-muted',
            fallbackClassName,
          )}
        >
          {name.charAt(0)}
        </span>
      )}
    </span>
  );
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          'flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          className,
        )}
        {...rest}
      />
    );
  },
);

/** Modal dialog: dimmed overlay, centred panel, close button; Escape and overlay click close it */
export function Dialog({
  open,
  onOpenChange,
  title,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/80" onClick={() => onOpenChange(false)} />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 sm:rounded-lg',
          className,
        )}
      >
        <div className="flex flex-col sy-1.5 text-center sm:text-left">{title}</div>
        {children}
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="lucide lucide-x h-4 w-4"
            aria-hidden
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
          <span className="sr-only">Close</span>
        </button>
      </div>
    </>
  );
}

export function DialogTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-lg font-semibold leading-none tracking-tight', className)} {...rest} />;
}

/** Square checkbox (role=checkbox) in the primary colour */
export function Checkbox({
  id,
  checked,
  onCheckedChange,
}: {
  id?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      id={id}
      aria-checked={checked}
      data-state={checked ? 'checked' : 'unchecked'}
      onClick={() => onCheckedChange(!checked)}
      className="peer grid h-4 w-4 shrink-0 place-content-center rounded-sm border border-primary shadow-sm focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
    >
      {checked ? (
        <span className="grid place-content-center text-current">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="lucide lucide-check h-4 w-4"
            aria-hidden
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
      ) : null}
    </button>
  );
}
