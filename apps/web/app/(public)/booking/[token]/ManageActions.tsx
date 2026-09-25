'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useState, useTransition } from 'react';
import { CalendarClock, XCircle } from 'lucide-react';
import { SlotPicker, type Day, type SlotItem } from '../../book/[shopSlug]/SlotPicker';
import { cancelBookingAction, rescheduleBookingAction } from './actions';

const WD = ['日', '月', '火', '水', '木', '金', '土'];
function fmtDate(date: string) {
  const [, m, d] = date.split('-').map(Number);
  return `${m}月${d}日(${WD[new Date(date + 'T00:00:00Z').getUTCDay()]})`;
}

export function ManageActions({ token, shopSlug, days, currentDate }: { token: string; shopSlug: string; days: Day[]; currentDate: string }) {
  const router = useRouter();
  const [panel, setPanel] = useState<'none' | 'change' | 'cancel'>('none');
  const [picked, setPicked] = useState<(SlotItem & { date: string }) | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [pending, start] = useTransition();

  const buildUrl = useCallback((date: string) => `/api/availability?${new URLSearchParams({ shop: shopSlug, date, appt: token })}`, [shopSlug, token]);

  const doChange = () => {
    if (!picked) return;
    setError(null);
    start(async () => {
      try {
        const r = await rescheduleBookingAction(token, picked.start);
        if (!r.ok) { setError(r.error); setPicked(null); setReloadKey((k) => k + 1); return; }
        setDone(r.message ?? '変更しました'); setPanel('none'); setPicked(null); router.refresh();
      } catch { setError('通信に失敗しました。もう一度お試しください。'); }
    });
  };
  const doCancel = () => {
    setError(null);
    start(async () => {
      try {
        const r = await cancelBookingAction(token, reason);
        if (!r.ok) { setError(r.error); return; }
        setDone(r.message ?? 'キャンセルしました'); setPanel('none'); router.refresh();
      } catch { setError('通信に失敗しました。もう一度お試しください。'); }
    });
  };

  return (
    <div className="stack">
      {done && <div className="alert success" role="status">{done}</div>}
      {error && <div className="alert error" role="alert">{error}</div>}
      {panel === 'none' && (
        <div className="grid-2">
          <button type="button" className="btn secondary lg" onClick={() => { setPanel('change'); setError(null); setDone(null); }}><CalendarClock size={16} />日時を変更</button>
          <button type="button" className="btn danger-outline lg" onClick={() => { setPanel('cancel'); setError(null); setDone(null); }}><XCircle size={16} />キャンセル</button>
        </div>
      )}
      {panel === 'change' && (
        <div className="card stack">
          <div className="between"><h3>新しい日時を選択</h3><button type="button" className="btn ghost sm" onClick={() => { setPanel('none'); setPicked(null); }}>閉じる</button></div>
          <p className="sub" style={{ margin: 0 }}>メニュー・担当は変わりません。</p>
          <SlotPicker days={days} buildUrl={buildUrl} selected={picked?.start ?? null} onSelect={(s, d) => setPicked({ ...s, date: d })} initialDate={currentDate} reloadKey={reloadKey} />
          {picked && (
            <div className="bk-bar">
              <div className="grow">変更後<br /><b>{fmtDate(picked.date)} {picked.time}〜</b></div>
              <button type="button" className="btn lg" onClick={doChange} disabled={pending} aria-busy={pending}>{pending ? <span className="spinner" /> : 'この日時に変更'}</button>
            </div>
          )}
        </div>
      )}
      {panel === 'cancel' && (
        <div className="card stack">
          <h3>ご予約をキャンセルしますか？</h3>
          <div className="field">
            <label htmlFor="mg-reason">キャンセル理由（任意）</label>
            <textarea id="mg-reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="差し支えなければご記入ください" />
          </div>
          <div className="row-wrap">
            <button type="button" className="btn danger" onClick={doCancel} disabled={pending} aria-busy={pending}>{pending ? <span className="spinner" /> : 'キャンセルする'}</button>
            <button type="button" className="btn ghost" onClick={() => setPanel('none')} disabled={pending}>やめる</button>
          </div>
        </div>
      )}
    </div>
  );
}
