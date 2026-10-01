import { useEffect, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Field, Textarea } from './Field';

/**
 * Confirmation dialog. With `reason` it asks for a free-text reason (e.g. キャンセル理由)
 * and passes it to onConfirm.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  children,
  confirmLabel = '実行する',
  cancelLabel = 'やめる',
  tone = 'primary',
  loading,
  reason,
  reasonLabel = '理由',
  reasonRequired,
  reasonPlaceholder,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason?: string) => unknown;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  loading?: boolean;
  reason?: boolean;
  reasonLabel?: string;
  reasonRequired?: boolean;
  reasonPlaceholder?: string;
}) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (open) setText('');
  }, [open]);
  const disabled = reason && reasonRequired && !text.trim();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      dismissable={!loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            loading={loading}
            disabled={disabled}
            onClick={() => void onConfirm(reason ? text.trim() || undefined : undefined)}
            data-autofocus={!reason || undefined}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {reason ? (
        <Field
          label={reasonLabel}
          required={reasonRequired}
          className={children ? 'mt-4' : undefined}
        >
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder={reasonPlaceholder}
            maxLength={500}
          />
        </Field>
      ) : null}
      {!children && !reason ? (
        <p className="text-[13px] text-muted">この操作を実行してよろしいですか？</p>
      ) : null}
    </Dialog>
  );
}
