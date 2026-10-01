import { cn } from '../../lib/cn';

export function Spinner({
  size = 16,
  className,
  label,
}: {
  size?: number;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      className={cn('animate-spin shrink-0', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function PageSpinner({ label = '読み込み中' }: { label?: string }) {
  return (
    <div
      className="flex min-h-[40vh] items-center justify-center text-muted"
      role="status"
      aria-live="polite"
    >
      <Spinner size={28} />
      <span className="sr-only">{label}</span>
    </div>
  );
}
