/** shadcn/ui-style Alert (new-york), written for Tailwind 4 */
import type { HTMLAttributes } from 'react';
import { cx } from '../../lib/cn';

const ALERT_VARIANTS = {
  default: 'bg-background text-foreground',
  destructive: 'border-destructive/50 text-destructive [&>svg]:text-destructive',
} as const;

export function Alert({
  variant = 'default',
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { variant?: keyof typeof ALERT_VARIANTS }) {
  return (
    <div
      role="alert"
      className={cx(
        'relative w-full rounded-lg border px-4 py-3 text-sm [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground [&>svg~*]:pl-7',
        ALERT_VARIANTS[variant],
        className,
      )}
      {...rest}
    />
  );
}

export function AlertTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h5 className={cx('mb-1 font-medium leading-none tracking-tight', className)} {...rest} />;
}

export function AlertDescription({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('text-sm [&_p]:leading-relaxed', className)} {...rest} />;
}
