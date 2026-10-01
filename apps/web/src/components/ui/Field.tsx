import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '../../lib/cn';

const controlBase =
  'w-full rounded-lg border bg-surface text-fg placeholder:text-subtle transition-colors outline-none ' +
  'focus:border-primary focus:ring-2 focus:ring-ring/30 disabled:opacity-60 disabled:bg-surface-2';

export function controlClass(invalid?: boolean, extra?: string) {
  return cn(controlBase, invalid ? 'border-danger' : 'border-border', extra);
}

/**
 * Label + control + hint/error wiring (htmlFor / aria-describedby / aria-invalid).
 * Pass exactly one control element as child; its id is injected.
 */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
  labelHidden,
  optional,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  optional?: boolean;
  children: ReactElement<Record<string, unknown>>;
  className?: string;
  labelHidden?: boolean;
}) {
  const id = useId();
  const childId = (isValidElement(children) && (children.props.id as string | undefined)) || id;
  const hintId = hint ? `${childId}-hint` : undefined;
  const errorId = error ? `${childId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label
        htmlFor={childId}
        className={cn('text-[13px] font-medium text-fg', labelHidden && 'sr-only')}
      >
        {label}
        {required ? (
          <span className="ml-1 text-danger" aria-hidden>
            *
          </span>
        ) : null}
        {optional ? <span className="ml-1 text-xs font-normal text-subtle">（任意）</span> : null}
      </label>
      {cloneElement(children, {
        id: childId,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        'aria-required': required || undefined,
        invalid: children.props.invalid ?? !!error,
      })}
      {hint && !error ? (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs font-medium text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> & {
  invalid?: boolean;
  inputSize?: 'sm' | 'md' | 'lg';
  leading?: ReactNode;
  trailing?: ReactNode;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, className, inputSize = 'md', leading, trailing, ...rest },
  ref,
) {
  const h =
    inputSize === 'sm'
      ? 'h-8 text-[13px] px-2.5'
      : inputSize === 'lg'
        ? 'h-12 text-base px-4'
        : 'h-10 text-sm px-3';
  if (leading || trailing) {
    return (
      <div
        className={cn(
          controlClass(invalid),
          'flex items-center gap-2 focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/30',
          h,
          'py-0',
        )}
      >
        {leading ? <span className="shrink-0 text-muted">{leading}</span> : null}
        <input
          ref={ref}
          className={cn(
            'min-w-0 flex-1 bg-transparent outline-none placeholder:text-subtle',
            className,
          )}
          {...rest}
        />
        {trailing ? <span className="shrink-0 text-xs text-muted">{trailing}</span> : null}
      </div>
    );
  }
  return <input ref={ref} className={controlClass(invalid, cn(h, className))} {...rest} />;
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function Textarea({ invalid, className, rows = 3, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={controlClass(invalid, cn('px-3 py-2 text-sm leading-relaxed', className))}
      {...rest}
    />
  );
});

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean; selectSize?: 'sm' | 'md' }
>(function Select({ invalid, className, children, selectSize = 'md', ...rest }, ref) {
  const h = selectSize === 'sm' ? 'h-8 text-[13px] pl-2.5 pr-8' : 'h-10 text-sm pl-3 pr-9';
  return (
    <div className="relative">
      <select
        ref={ref}
        className={controlClass(invalid, cn('appearance-none', h, className))}
        {...rest}
      >
        {children}
      </select>
      <svg
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  );
});

export function Checkbox({
  label,
  description,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: ReactNode;
  description?: ReactNode;
}) {
  const id = useId();
  const inputId = rest.id ?? id;
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <input
        id={inputId}
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-border-strong accent-[var(--primary)]"
        {...rest}
      />
      <label htmlFor={inputId} className="cursor-pointer text-sm leading-snug">
        <span className="text-fg">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-xs text-muted">{description}</span>
        ) : null}
      </label>
    </div>
  );
}

/** Accessible toggle switch (role=switch) */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  className,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  const auto = useId();
  const sid = id ?? auto;
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <label htmlFor={sid} className="cursor-pointer text-sm font-medium text-fg">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
      </div>
      <button
        id={sid}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
          checked ? 'bg-primary' : 'bg-surface-3 border border-border-strong',
        )}
      >
        <span
          className={cn(
            'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-[22px]' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}

/** Segmented radio group */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = 'md',
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; disabled?: boolean }[];
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('inline-flex rounded-lg border border-border bg-surface-2 p-0.5', className)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md font-medium transition-colors disabled:opacity-40',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-[13px]',
            value === o.value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
