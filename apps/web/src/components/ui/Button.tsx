import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { cn } from '../../lib/cn';
import { Icon, type IconName } from './Icon';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline' | 'soft';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary-hover shadow-sm',
  secondary: 'bg-surface text-fg border border-border hover:bg-surface-2 shadow-sm',
  outline: 'border border-border-strong text-fg hover:bg-surface-2',
  ghost: 'text-fg hover:bg-surface-2',
  soft: 'bg-primary-soft text-primary hover:brightness-95',
  danger: 'bg-danger text-white hover:brightness-110 shadow-sm',
};

const sizes: Record<ButtonSize, string> = {
  xs: 'h-7 px-2 text-xs gap-1 rounded-md',
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-lg',
  lg: 'h-12 px-5 text-base gap-2 rounded-xl',
};

export function buttonClass(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  extra?: string,
) {
  return cn(
    'inline-flex items-center justify-center font-medium whitespace-nowrap select-none transition-colors',
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
    variants[variant],
    sizes[size],
    extra,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: IconName;
  iconRight?: IconName;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading,
    icon,
    iconRight,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  const iconSize = size === 'lg' ? 20 : size === 'xs' ? 14 : 16;
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={iconSize} /> : icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
      {iconRight && !loading ? <Icon name={iconRight} size={iconSize} /> : null}
    </button>
  );
});

export function IconButton({
  icon,
  label,
  variant = 'ghost',
  size = 'md',
  className,
  ...rest
}: { icon: IconName; label: string; variant?: ButtonVariant; size?: ButtonSize } & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
>) {
  const dim =
    size === 'xs'
      ? 'h-7 w-7'
      : size === 'sm'
        ? 'h-8 w-8'
        : size === 'lg'
          ? 'h-12 w-12'
          : 'h-10 w-10';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(buttonClass(variant, size), dim, '!px-0', className)}
      {...rest}
    >
      <Icon name={icon} size={size === 'xs' ? 14 : size === 'lg' ? 22 : 18} />
    </button>
  );
}

export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}: LinkProps & { variant?: ButtonVariant; size?: ButtonSize; icon?: IconName }) {
  return (
    <Link className={buttonClass(variant, size, className)} {...rest}>
      {icon ? <Icon name={icon} size={size === 'lg' ? 20 : 16} /> : null}
      {children}
    </Link>
  );
}
