/**
 * shadcn/ui-style AlertDialog (new-york), written for Tailwind 4: a confirmation that needs an
 * explicit answer. Unlike Dialog it has no close button and the overlay does not dismiss it;
 * Escape cancels unless `busy`.
 */
import { useEffect, useId, type ReactNode } from 'react';
import { cx } from '../../lib/cn';
import { buttonVariants } from './index';

export function AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  cancelLabel = 'キャンセル',
  actionLabel,
  onAction,
  actionClassName,
  busy = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  cancelLabel?: ReactNode;
  actionLabel: ReactNode;
  onAction: () => void;
  actionClassName?: string;
  /** disables both buttons while the action runs */
  busy?: boolean;
}) {
  const titleId = useId();
  const descId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onOpenChange]);
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/80" />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 sm:rounded-lg"
      >
        <div className="flex flex-col sy-2 text-center sm:text-left">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          <p id={descId} className="text-sm text-muted-foreground">
            {description}
          </p>
        </div>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:sx-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onOpenChange(false)}
            className={buttonVariants('outline', 'default', 'mt-2 sm:mt-0')}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onAction}
            className={cx(buttonVariants(), actionClassName)}
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </>
  );
}
