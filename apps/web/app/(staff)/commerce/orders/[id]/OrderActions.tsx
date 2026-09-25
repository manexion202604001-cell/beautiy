'use client';
import { ActionForm, ModalButton, SubmitButton } from '@/components/client';
import { orderStatusAction, trackingAction } from '../../actions';

export function OrderActions({ orderId, status, trackingNumber, online }: { orderId: string; status: string; trackingNumber: string | null; online: boolean }) {
  return (
    <div className="toolbar">
      {status === 'PENDING' && (
        <ModalButton label="支払い済みにする" title="支払い済みにする">
          {(close) => (
            <ActionForm action={orderStatusAction} onSuccess={() => setTimeout(close, 700)}>
              <input type="hidden" name="orderId" value={orderId} /><input type="hidden" name="to" value="PAID" />
              <p>店頭受け取り・振込などで代金を受領した場合に使用します。在庫が引き当てられ、定期便が開始されます。</p>
              <div className="form-actions"><button type="button" className="btn secondary" onClick={close}>閉じる</button><SubmitButton>支払い済みにする</SubmitButton></div>
            </ActionForm>
          )}
        </ModalButton>
      )}
      {status === 'PAID' && (
        <ModalButton label="発送済みにする" title="発送済みにする">
          {(close) => (
            <ActionForm action={orderStatusAction} onSuccess={() => setTimeout(close, 700)}>
              <input type="hidden" name="orderId" value={orderId} /><input type="hidden" name="to" value="FULFILLED" />
              <div className="field"><label htmlFor="trackingNumber">配送伝票番号（任意）</label><input id="trackingNumber" name="trackingNumber" className="input" maxLength={60} defaultValue={trackingNumber ?? ''} /></div>
              <div className="form-actions"><button type="button" className="btn secondary" onClick={close}>閉じる</button><SubmitButton>発送済みにする</SubmitButton></div>
            </ActionForm>
          )}
        </ModalButton>
      )}
      {status === 'FULFILLED' && (
        <ModalButton label="伝票番号を編集" className="btn secondary" title="配送伝票番号">
          {(close) => (
            <ActionForm action={trackingAction} onSuccess={() => setTimeout(close, 700)}>
              <input type="hidden" name="orderId" value={orderId} />
              <div className="field"><label htmlFor="tn">配送伝票番号</label><input id="tn" name="trackingNumber" className="input" maxLength={60} defaultValue={trackingNumber ?? ''} /></div>
              <div className="form-actions"><SubmitButton>保存</SubmitButton></div>
            </ActionForm>
          )}
        </ModalButton>
      )}
      {status === 'PENDING' && (
        <ModalButton label="キャンセル" className="btn danger-outline" title="注文のキャンセル">
          {(close) => (
            <ActionForm action={orderStatusAction} onSuccess={() => setTimeout(close, 700)}>
              <input type="hidden" name="orderId" value={orderId} /><input type="hidden" name="to" value="CANCELLED" />
              <div className="field"><label htmlFor="reason">理由</label><input id="reason" name="reason" className="input" maxLength={300} /></div>
              <div className="form-actions"><button type="button" className="btn secondary" onClick={close}>閉じる</button><SubmitButton className="btn danger">キャンセルする</SubmitButton></div>
            </ActionForm>
          )}
        </ModalButton>
      )}
      {(status === 'PAID' || status === 'FULFILLED') && (
        <ModalButton label="返金" className="btn danger-outline" title="注文の返金">
          {(close) => (
            <ActionForm action={orderStatusAction} onSuccess={() => setTimeout(close, 700)}>
              <input type="hidden" name="orderId" value={orderId} /><input type="hidden" name="to" value="REFUNDED" />
              <p>{online ? 'オンライン決済は決済事業者を通じて全額返金されます。' : '代金の返金はお客様と個別に行ってください。'}関連する定期便は解約されます。</p>
              <div className="field"><label htmlFor="rreason">理由</label><input id="rreason" name="reason" className="input" maxLength={300} /></div>
              <label className="checkbox" style={{ marginTop: 8 }}><input type="checkbox" name="restock" />商品を在庫に戻す</label>
              <div className="form-actions"><button type="button" className="btn secondary" onClick={close}>閉じる</button><SubmitButton className="btn danger">返金する</SubmitButton></div>
            </ActionForm>
          )}
        </ModalButton>
      )}
    </div>
  );
}
