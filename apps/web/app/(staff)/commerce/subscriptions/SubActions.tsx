'use client';
import { ActionForm, ConfirmAction, ModalButton, SubmitButton } from '@/components/client';
import { subscriptionAction, subscriptionFormAction } from '../actions';

export function SubActions({ id, status, nextShipAt }: { id: string; status: string; nextShipAt: string }) {
  if (status === 'CANCELLED') return null;
  return (
    <span className="row-wrap" style={{ justifyContent: 'flex-end' }}>
      {status === 'ACTIVE' && <ConfirmAction action={subscriptionAction} fields={{ id, action: 'shipped' }} confirm="出荷済みにして次回お届け日を進めますか？（在庫が減ります）">出荷済み</ConfirmAction>}
      {status === 'ACTIVE' && <ConfirmAction action={subscriptionAction} fields={{ id, action: 'pause' }} confirm="この定期便を一時停止しますか？">一時停止</ConfirmAction>}
      {status === 'PAUSED' && <ConfirmAction action={subscriptionAction} fields={{ id, action: 'resume' }}>再開</ConfirmAction>}
      <ModalButton label="日付変更" className="btn secondary sm" title="次回お届け日の変更">
        {(close) => (
          <ActionForm action={subscriptionFormAction} onSuccess={() => setTimeout(close, 600)}>
            <input type="hidden" name="id" value={id} /><input type="hidden" name="action" value="reschedule" />
            <div className="field"><label htmlFor={`d-${id}`}>次回お届け日</label><input id={`d-${id}`} type="date" name="nextShipAt" className="input" defaultValue={nextShipAt} required /></div>
            <div className="form-actions"><SubmitButton>変更する</SubmitButton></div>
          </ActionForm>
        )}
      </ModalButton>
      <ConfirmAction action={subscriptionAction} fields={{ id, action: 'cancel' }} confirm="この定期便を解約しますか？元に戻せません。" className="btn danger-outline sm">解約</ConfirmAction>
    </span>
  );
}
