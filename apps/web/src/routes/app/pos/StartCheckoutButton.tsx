import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { posApi, posKeys } from '../../../api/pos';
import { Button, useToast, type ButtonProps } from '../../../components/ui';
import { isApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useStableKey } from '../../../lib/hooks';
import { newIdempotencyKey } from '../../../lib/api';

/** Statuses that can be billed (POS completes the appointment when the transaction is completed) */
export const BILLABLE_STATUSES = [
  'tentative',
  'confirmed',
  'checked_in',
  'in_service',
  'completed',
];

/**
 * 「会計する」: creates (or reopens) the draft transaction for an appointment and opens the checkout.
 * An existing transaction for the appointment (TRANSACTION_EXISTS) is opened instead.
 */
export function StartCheckoutButton({
  appointmentId,
  shopId,
  status,
  size = 'sm',
  variant = 'primary',
  label = '会計する',
  className,
  onNavigate,
}: {
  appointmentId: string;
  shopId: string;
  status: string;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
  label?: string;
  className?: string;
  onNavigate?: () => void;
}) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [key, regenerate] = useStableKey(newIdempotencyKey);
  if (!can('pos.operate') || !BILLABLE_STATUSES.includes(status)) return null;

  const go = (id: string) => {
    onNavigate?.();
    navigate(`/app/pos/checkout/${id}`);
  };

  const start = async () => {
    setBusy(true);
    try {
      const tx = await posApi.create({ shopId, appointmentId }, key);
      void qc.invalidateQueries({ queryKey: posKeys.all });
      regenerate();
      if (tx.warnings?.length) toast.info('会計を作成しました', tx.warnings.join(' / '));
      go(tx.id);
    } catch (e) {
      if (isApiError(e) && e.code === 'TRANSACTION_EXISTS') {
        const id = (e.details as { transactionId?: string } | undefined)?.transactionId;
        if (id) {
          regenerate();
          go(id);
          return;
        }
      }
      if (isApiError(e) && e.status > 0) regenerate();
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      size={size}
      variant={variant}
      icon="receipt"
      loading={busy}
      onClick={(e) => {
        e.stopPropagation();
        void start();
      }}
      className={className}
      data-testid="start-checkout"
    >
      {label}
    </Button>
  );
}
