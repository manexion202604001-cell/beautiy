'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { ActionForm, ModalButton, SubmitButton } from '@/components/client';
import { addWaitlistAction, setWaitlistStatusAction } from './actions';
import { WAIT_STATUS_LABEL } from './labels';

export function WaitlistAddButton({ staff, defaultDate }: { staff: { userId: string; name: string }[]; defaultDate: string }) {
  return (
    <ModalButton label={<><Plus size={15} />追加</>} title="キャンセル待ちを追加" className="btn sm">
      {(close) => (
        <ActionForm action={addWaitlistAction} onSuccess={close} resetOnSuccess>
          <div className="form-grid">
            <div className="field"><label htmlFor="wl-name" className="req">お名前</label><input id="wl-name" name="name" className="input" required maxLength={60} /></div>
            <div className="field"><label htmlFor="wl-contact">連絡先（電話・メール）</label><input id="wl-contact" name="contact" className="input" maxLength={100} /></div>
            <div className="field"><label htmlFor="wl-date" className="req">希望日</label><input id="wl-date" name="desiredDate" type="date" className="input" required defaultValue={defaultDate} min={defaultDate} /></div>
            <div className="field"><label htmlFor="wl-time">希望時間</label><input id="wl-time" name="timeNote" className="input" placeholder="例：15時以降" maxLength={100} /></div>
            <div className="field"><label htmlFor="wl-menu">希望メニュー</label><input id="wl-menu" name="menuNote" className="input" placeholder="例：カット＋カラー" maxLength={200} /></div>
            <div className="field">
              <label htmlFor="wl-staff">担当希望</label>
              <select id="wl-staff" name="staffId" className="select" defaultValue="">
                <option value="">指名なし</option>
                {staff.map((s) => <option key={s.userId} value={s.userId}>{s.name}</option>)}
              </select>
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn secondary" onClick={close}>キャンセル</button>
            <SubmitButton pendingText="追加中…">追加する</SubmitButton>
          </div>
        </ActionForm>
      )}
    </ModalButton>
  );
}

export function WaitlistStatusSelect({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [value, setValue] = useState(status);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="stack-sm">
      <select
        className="select sm" value={value} disabled={busy} aria-label="ステータス" style={{ width: 'auto' }}
        onChange={async (e) => {
          const next = e.target.value;
          const prev = value;
          setValue(next); setBusy(true); setErr(null);
          const fd = new FormData();
          fd.set('id', id); fd.set('status', next);
          try {
            const r = await setWaitlistStatusAction(fd);
            if (!r.ok) { setValue(prev); setErr(r.error); } else router.refresh();
          } catch { setValue(prev); setErr('更新に失敗しました'); } finally { setBusy(false); }
        }}
      >
        {Object.entries(WAIT_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      {err && <span className="form-error">{err}</span>}
    </span>
  );
}
