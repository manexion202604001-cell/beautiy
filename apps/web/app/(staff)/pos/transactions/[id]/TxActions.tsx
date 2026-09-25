'use client';
import { useState } from 'react';
import { ActionForm, ModalButton, SubmitButton } from '@/components/client';
import { yen } from '@/lib/format';
import { METHOD_LABEL, PAYMENT_METHODS } from '@/lib/pos-shared';
import { refundAction, voidFormAction } from '../../actions';

interface Item { id: string; name: string; quantity: number; restockable: number }

export function RefundButton({ transactionId, refundable, defaultMethod, retailItems }: { transactionId: string; refundable: number; defaultMethod: string; retailItems: Item[] }) {
  const [amount, setAmount] = useState(String(refundable));
  return (
    <ModalButton label="返金" className="btn danger-outline" title="返金">
      {(close) => (
        <ActionForm action={refundAction} onSuccess={() => setTimeout(close, 900)} successMessage="返金しました">
          <input type="hidden" name="transactionId" value={transactionId} />
          <div className="alert info" style={{ marginBottom: 12 }}>返金可能額：<strong>{yen(refundable)}</strong>。付与ポイントは返金額に応じて取り消されます。</div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="amount" className="req">返金額（円）</label>
              <input id="amount" name="amount" className="input num" inputMode="numeric" required value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} />
              <div className="row" style={{ gap: 6, marginTop: 4 }}>
                <button type="button" className="chip" onClick={() => setAmount(String(refundable))}>全額</button>
              </div>
            </div>
            <div className="field">
              <label htmlFor="method" className="req">返金方法</label>
              <select id="method" name="method" className="select" defaultValue={defaultMethod}>
                {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
              </select>
              <div className="hint">現金返金はレジが開いている必要があります。Stripe/Squareは決済事業者で返金されます。</div>
            </div>
            <div className="field full">
              <label htmlFor="reason" className="req">返金理由</label>
              <input id="reason" name="reason" className="input" required maxLength={300} placeholder="例：商品返品、施術やり直し" />
            </div>
            {retailItems.length > 0 && (
              <div className="field full">
                <label>在庫に戻す店販商品</label>
                {retailItems.map((i) => (
                  <div key={i.id} className="between" style={{ padding: '4px 0' }}>
                    <span>{i.name} <span className="sub">（購入 {i.quantity} / 戻し可能 {i.restockable}）</span></span>
                    <input name={`restock_${i.id}`} className="input sm num" style={{ width: 72 }} type="number" min={0} max={i.restockable} defaultValue={0} disabled={i.restockable <= 0} aria-label={`${i.name}の返品数`} />
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="form-actions">
            <button type="button" className="btn secondary" onClick={close}>閉じる</button>
            <SubmitButton className="btn danger" pendingText="返金中…">返金を実行</SubmitButton>
          </div>
        </ActionForm>
      )}
    </ModalButton>
  );
}

export function VoidButton({ transactionId, draft }: { transactionId: string; draft: boolean }) {
  return (
    <ModalButton label={draft ? '下書きを破棄' : '取消（当日）'} className="btn danger-outline" title={draft ? '下書きを破棄' : '会計の取消'}>
      {(close) => (
        <ActionForm action={voidFormAction} onSuccess={() => setTimeout(close, 900)}>
          <input type="hidden" name="transactionId" value={transactionId} />
          <p>{draft ? 'この下書きを破棄します。' : '会計を取り消し、ポイント・在庫を元に戻します。決済事業者経由の支払いは返金されます。この操作は元に戻せません。'}</p>
          <div className="field">
            <label htmlFor="reason">理由</label>
            <input id="reason" name="reason" className="input" maxLength={300} placeholder="例：打ち間違いのため再会計" />
          </div>
          <div className="form-actions">
            <button type="button" className="btn secondary" onClick={close}>閉じる</button>
            <SubmitButton className="btn danger" pendingText="処理中…">{draft ? '破棄する' : '取り消す'}</SubmitButton>
          </div>
        </ActionForm>
      )}
    </ModalButton>
  );
}
