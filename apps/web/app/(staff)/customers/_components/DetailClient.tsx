'use client';
import { useActionState, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Plus, X, KeyRound, Send } from 'lucide-react';
import { ActionForm, CopyButton, Modal, SubmitButton } from '@/components/client';
import type { ActionResult } from '@/lib/server/errors';
import { addTagAction, adjustPointsAction, issueCounselingAction, removeTagAction, requestOtpAction, verifyOtpAction } from '../actions';

// ── PII unlock (OTP) ──

export function PiiUnlockButton({ className = 'btn secondary sm' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'intro' | 'code'>('intro');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const [state, verify] = useActionState<ActionResult<{ expiresAt: string }> | null, FormData>(verifyOtpAction, null);

  useEffect(() => {
    if (state?.ok) { setOpen(false); setStep('intro'); router.refresh(); }
  }, [state, router]);

  const request = () => start(async () => {
    setErr(null);
    const r = await requestOtpAction();
    if (!r.ok) { setErr(r.error); return; }
    setDevCode(r.data?.devCode ?? null);
    setStep('code');
  });

  return (
    <>
      <button type="button" className={className} onClick={() => { setOpen(true); setStep('intro'); setErr(null); }}><Lock size={14} />ロック解除</button>
      <Modal open={open} onClose={() => setOpen(false)} title="個人情報のロック解除">
        {step === 'intro' ? (
          <div className="stack">
            <p>電話番号・メール・住所を一時的に表示します。本人確認のため、登録メールアドレスに6桁の確認コードを送信します。</p>
            <ul className="sub" style={{ margin: 0, paddingLeft: 18 }}>
              <li>解除は30分間有効です（全顧客に適用）</li>
              <li>解除・閲覧はすべて監査ログに記録されます</li>
            </ul>
            {err && <div className="alert error">{err}</div>}
            <div className="form-actions">
              <button type="button" className="btn secondary" onClick={() => setOpen(false)}>キャンセル</button>
              <button type="button" className="btn" onClick={request} disabled={pending}>{pending ? <span className="spinner" /> : <KeyRound size={14} />}確認コードを送信</button>
            </div>
          </div>
        ) : (
          <form action={verify} className="stack">
            {devCode && <div className="alert warn">開発モード: 確認コードは <strong className="mono" style={{ fontSize: 14 }}>{devCode}</strong> です（本番ではメールで届きます）</div>}
            {state && !state.ok && <div className="alert error" role="alert">{state.error}{state.fieldErrors && Object.values(state.fieldErrors).map((m) => <div key={m}>{m}</div>)}</div>}
            <div className="field">
              <label htmlFor="otp-code" className="req">確認コード（6桁）</label>
              <input id="otp-code" name="code" className="input mono" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" required autoFocus style={{ fontSize: 18, letterSpacing: '.3em' }} />
            </div>
            <div className="field">
              <label htmlFor="otp-reason" className="req">閲覧理由</label>
              <input id="otp-reason" name="reason" className="input" required maxLength={200} placeholder="例: 予約変更の電話連絡のため" list="otp-reasons" />
              <datalist id="otp-reasons">
                <option value="予約変更・確認の連絡のため" />
                <option value="お忘れ物の連絡のため" />
                <option value="顧客情報の更新のため" />
                <option value="データ移行・CSV出力のため" />
              </datalist>
            </div>
            <div className="between">
              <button type="button" className="btn ghost sm" onClick={request} disabled={pending}>コードを再送信</button>
              <SubmitButton pendingText="確認中…">ロックを解除</SubmitButton>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

// ── Tags ──

export function TagEditor({ customerId, tags, allTags, canEdit }: {
  customerId: string; tags: { id: string; name: string; color: string }[]; allTags: { id: string; name: string; color: string }[]; canEdit: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [sel, setSel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  const available = allTags.filter((t) => !tags.some((x) => x.id === t.id));
  const remove = async (tagId: string) => {
    setBusy(tagId); setErr(null);
    const fd = new FormData(); fd.set('customerId', customerId); fd.set('tagId', tagId);
    const r = await removeTagAction(fd);
    if (!r.ok) setErr(r.error);
    setBusy(null); router.refresh();
  };
  return (
    <div className="stack-sm">
      <div className="row-wrap" style={{ gap: 6 }}>
        {tags.length === 0 && <span className="sub">タグはありません</span>}
        {tags.map((t) => (
          <span key={t.id} className="crm-tag" style={{ ['--tag' as string]: t.color }}>
            {t.name}
            {canEdit && <button type="button" aria-label={`${t.name}を外す`} onClick={() => remove(t.id)} disabled={busy === t.id}>{busy === t.id ? '…' : <X size={11} />}</button>}
          </span>
        ))}
        {canEdit && !adding && <button type="button" className="btn ghost sm" onClick={() => setAdding(true)}><Plus size={13} />タグ追加</button>}
      </div>
      {err && <div className="form-error">{err}</div>}
      {canEdit && adding && (
        <ActionForm action={addTagAction} onSuccess={() => { setAdding(false); setSel(''); }} showSuccess={false} resetOnSuccess>
          <input type="hidden" name="customerId" value={customerId} />
          <div className="row-wrap">
            <select name="tagId" className="select sm" value={sel} onChange={(e) => setSel(e.target.value)} style={{ width: 'auto', minWidth: 140 }} aria-label="タグを選択">
              <option value="">タグを選択…</option>
              {available.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              <option value="__new">＋ 新しいタグを作成</option>
            </select>
            {sel === '__new' && (
              <>
                <input name="name" className="input sm" placeholder="タグ名" maxLength={30} required style={{ width: 140 }} aria-label="新しいタグ名" autoFocus />
                <input name="color" type="color" defaultValue="#4d6fff" aria-label="タグの色" style={{ width: 34, height: 30, border: 0, background: 'none', padding: 0 }} />
              </>
            )}
            <SubmitButton className="btn sm" disabled={!sel}>追加</SubmitButton>
            <button type="button" className="btn ghost sm" onClick={() => { setAdding(false); setSel(''); }}>閉じる</button>
          </div>
        </ActionForm>
      )}
    </div>
  );
}

// ── Points ──

export function PointAdjustButton({ customerId, balance }: { customerId: string; balance: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn secondary sm" onClick={() => setOpen(true)}>ポイント調整</button>
      <Modal open={open} onClose={() => setOpen(false)} title="ポイントの手動調整">
        <ActionForm action={adjustPointsAction} onSuccess={() => setTimeout(() => setOpen(false), 900)}>
          <input type="hidden" name="customerId" value={customerId} />
          <p className="sub">現在の残高: <strong>{balance.toLocaleString('ja-JP')}pt</strong>。調整は監査ログに記録されます。</p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="pt-dir">種類</label>
              <select id="pt-dir" name="direction" className="select" defaultValue="add"><option value="add">付与（＋）</option><option value="sub">減算（−）</option></select>
            </div>
            <div className="field">
              <label htmlFor="pt-amount" className="req">ポイント数</label>
              <input id="pt-amount" name="amount" type="number" min={1} max={1000000} step={1} className="input" required />
            </div>
            <div className="field full">
              <label htmlFor="pt-reason" className="req">理由</label>
              <input id="pt-reason" name="reason" className="input" required maxLength={100} placeholder="例: 誕生日特典 / 付与漏れの補正" />
            </div>
          </div>
          <div className="form-actions"><SubmitButton>調整する</SubmitButton></div>
        </ActionForm>
      </Modal>
    </>
  );
}

// ── Counseling link ──

export function IssueCounselingButton({ customerId, forms, appointments, canSend }: {
  customerId: string; forms: { id: string; name: string }[]; appointments: { id: string; label: string }[]; canSend: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  return (
    <>
      <button type="button" className="btn secondary sm" onClick={() => { setOpen(true); setUrl(null); }} disabled={!forms.length} title={forms.length ? undefined : 'カルテ > カウンセリングフォームで作成してください'}><Send size={14} />カウンセリング依頼</button>
      <Modal open={open} onClose={() => setOpen(false)} title="カウンセリングシートの記入依頼">
        <ActionForm<{ url: string; status?: string }> action={issueCounselingAction} onSuccess={(r) => r.ok && setUrl(r.data?.url ?? null)}>
          <input type="hidden" name="customerId" value={customerId} />
          <div className="stack">
            <div className="field">
              <label htmlFor="cf-form" className="req">フォーム</label>
              <select id="cf-form" name="formId" className="select" required>{forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
            </div>
            {appointments.length > 0 && (
              <div className="field">
                <label htmlFor="cf-appt">対象の予約（任意）</label>
                <select id="cf-appt" name="appointmentId" className="select" defaultValue={appointments[0]?.id}>
                  <option value="">指定しない</option>
                  {appointments.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </div>
            )}
            {canSend && <label className="checkbox"><input type="checkbox" name="send" defaultChecked />LINE／メールでお客様に送信する</label>}
            {url && (
              <div className="alert info">
                <div className="sub" style={{ marginBottom: 6 }}>お客様用リンク（ログイン不要・1回のみ回答可）</div>
                <div className="row" style={{ alignItems: 'stretch' }}><input className="input sm mono" readOnly value={url} onFocus={(e) => e.target.select()} /><CopyButton text={url} /></div>
              </div>
            )}
            <div className="form-actions"><SubmitButton>{url ? 'もう一度発行' : 'リンクを発行'}</SubmitButton></div>
          </div>
        </ActionForm>
      </Modal>
    </>
  );
}
