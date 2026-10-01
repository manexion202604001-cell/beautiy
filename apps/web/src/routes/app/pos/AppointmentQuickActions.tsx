import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { AppointmentDetail } from '../../../api/types';
import { Button } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { SendFormDialog } from '../kartes/SendFormDialog';
import { StartCheckoutButton } from './StartCheckoutButton';

/** Extra actions in the appointment drawer: 会計する / カルテ / 事前問診を送る */
export function AppointmentQuickActions({
  a,
  onNavigate,
}: {
  a: AppointmentDetail;
  onNavigate?: () => void;
}) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [sending, setSending] = useState(false);
  const active = !['cancelled', 'no_show'].includes(a.status);
  const canSendForm = !!a.customer_id && active && (can('appointment.write') || can('karte.write'));
  const canKarte = !!a.customer_id && active && can('karte.write');
  if (!active) return null;
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="会計・カルテ">
      <StartCheckoutButton
        appointmentId={a.id}
        shopId={a.shop_id}
        status={a.status}
        onNavigate={onNavigate}
      />
      {canKarte ? (
        <Button
          size="sm"
          icon="file"
          onClick={() => {
            onNavigate?.();
            navigate(`/app/kartes/new?customerId=${a.customer_id}&appointmentId=${a.id}`);
          }}
        >
          カルテを書く
        </Button>
      ) : null}
      {canSendForm ? (
        <Button size="sm" icon="send" onClick={() => setSending(true)}>
          事前問診を送る
        </Button>
      ) : null}
      {sending ? <SendFormDialog appointmentId={a.id} onClose={() => setSending(false)} /> : null}
    </div>
  );
}
