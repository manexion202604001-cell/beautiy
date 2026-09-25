'use client';
import { useMemo, useState } from 'react';
import { ActionForm, SubmitButton } from '@/components/client';
import { yen } from '@/lib/format';
import { closeRegisterAction, openRegisterAction } from '../actions';

const DENOMS = [10000, 5000, 2000, 1000, 500, 100, 50, 10, 5, 1];

function DenominationCounter({ onTotal }: { onTotal: (n: number) => void }) {
  const [counts, setCounts] = useState<Record<number, string>>({});
  const total = useMemo(() => DENOMS.reduce((a, d) => a + d * (Number(counts[d]) || 0), 0), [counts]);
  return (
    <details className="card pad-sm" style={{ boxShadow: 'none' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>金種で数える（合計 {yen(total)}）</summary>
      <div className="denoms" style={{ marginTop: 10 }}>
        {DENOMS.map((d) => (
          <label key={d}>
            <span style={{ width: 64, textAlign: 'right' }}>{yen(d)}</span>
            <input className="input sm num" inputMode="numeric" value={counts[d] ?? ''} placeholder="0"
              onChange={(e) => setCounts((c) => ({ ...c, [d]: e.target.value.replace(/[^\d]/g, '') }))} aria-label={`${d}円の枚数`} />
            <span className="sub">枚</span>
          </label>
        ))}
      </div>
      <div className="form-actions"><button type="button" className="btn secondary sm" onClick={() => onTotal(total)}>この金額を実際の現金に反映</button></div>
    </details>
  );
}

export function OpenRegisterForm({ shopId, suggested }: { shopId: string; suggested: number }) {
  const [amount, setAmount] = useState(String(suggested));
  return (
    <ActionForm action={openRegisterAction} successMessage="レジを開けました">
      <input type="hidden" name="shopId" value={shopId} />
      <div className="stack">
        <DenominationCounter onTotal={(n) => setAmount(String(n))} />
        <div className="form-grid">
          <div className="field">
            <label htmlFor="openingCash" className="req">釣銭準備金（円）</label>
            <input id="openingCash" name="openingCash" className="input num" inputMode="numeric" required value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} />
            <div className="hint">前回締めの実際の現金額を初期値にしています</div>
          </div>
          <div className="field">
            <label htmlFor="note">メモ</label>
            <input id="note" name="note" className="input" maxLength={300} />
          </div>
        </div>
        <div className="form-actions"><SubmitButton pendingText="処理中…">レジを開ける</SubmitButton></div>
      </div>
    </ActionForm>
  );
}

export function CloseRegisterForm({ sessionId, expected }: { sessionId: string; expected: number }) {
  const [amount, setAmount] = useState('');
  const actual = amount === '' ? null : Number(amount);
  const diff = actual === null ? null : actual - expected;
  return (
    <ActionForm action={closeRegisterAction}>
      <input type="hidden" name="sessionId" value={sessionId} />
      <div className="stack">
        <DenominationCounter onTotal={(n) => setAmount(String(n))} />
        <div className="form-grid">
          <div className="field">
            <label htmlFor="actualCash" className="req">実際の現金額（円）</label>
            <input id="actualCash" name="actualCash" className="input num" inputMode="numeric" required value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} />
          </div>
          <div className="field">
            <label>差額</label>
            <div style={{ fontSize: 22, fontWeight: 800, padding: '4px 0' }} className={diff === null ? 'muted' : diff === 0 ? '' : diff > 0 ? 'diff-plus' : 'diff-minus'}>
              {diff === null ? '—' : `${diff > 0 ? '+' : ''}${yen(diff)}`}
            </div>
            <div className="hint">理論現金 {yen(expected)}</div>
          </div>
          <div className="field full">
            <label htmlFor="closeNote">メモ{diff !== null && diff !== 0 ? '（差額の理由）' : ''}</label>
            <textarea id="closeNote" name="note" className="textarea" style={{ minHeight: 60 }} maxLength={500} />
          </div>
        </div>
        <div className="form-actions"><SubmitButton className="btn" pendingText="締め処理中…" disabled={actual === null}>レジを締める</SubmitButton></div>
      </div>
    </ActionForm>
  );
}
