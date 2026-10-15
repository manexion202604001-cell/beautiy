import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, Wordmark } from '../../components/shad';
import { cx } from '../../lib/cn';

/** Centered card used by the staff login / password reset / first-run screens */
export function AuthCard({
  description,
  children,
  headerExtra,
  className,
  cardClassName,
}: {
  description: ReactNode;
  children: ReactNode;
  /** shown in the header under the description (e.g. step progress) */
  headerExtra?: ReactNode;
  className?: string;
  cardClassName?: string;
}) {
  return (
    <div
      className={cx(
        'flex min-h-screen items-center justify-center px-4 text-base leading-normal',
        className,
      )}
    >
      <Card className={cx('w-full max-w-md', cardClassName)}>
        <CardHeader className="text-center">
          <div className="text-2xl font-semibold tracking-tight">
            <Wordmark />
          </div>
          <CardDescription>{description}</CardDescription>
          {headerExtra}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}

export function AuthError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

/** Error message shown as a tinted box at the top of a form */
export function AuthErrorBox({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="alert"
      className={cx('rounded-md bg-destructive/15 p-3 text-sm text-destructive', className)}
    >
      {children}
    </div>
  );
}
