'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult } from '@/lib/server/errors';
import { ActionForm, ModalButton, SubmitButton } from '@/components/client';
import { replyReviewAction } from './actions';

export function ReplyButton({ reviewId, reply, author, source }: { reviewId: string; reply: string | null; author: string; source: string }) {
  return (
    <ModalButton label={reply ? '返信を編集' : '返信する'} title={`${author}様への返信`} className={reply ? 'btn secondary sm' : 'btn sm'}>
      {(close) => (
        <ActionForm action={replyReviewAction} onSuccess={(r) => { if (r.ok) setTimeout(close, 900); }}>
          <input type="hidden" name="reviewId" value={reviewId} />
          <div className="field">
            <label htmlFor={`reply-${reviewId}`}>返信内容</label>
            <textarea id={`reply-${reviewId}`} name="reply" className="textarea" rows={6} maxLength={2000} defaultValue={reply ?? ''} placeholder="ご来店ありがとうございました。…" />
            <div className="hint">返信は公開ページに表示されます{source === 'GOOGLE' ? '（Googleビジネスプロフィールにも反映）' : ''}。空欄で保存すると返信を削除します。</div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn secondary" onClick={close}>キャンセル</button>
            <SubmitButton>保存</SubmitButton>
          </div>
        </ActionForm>
      )}
    </ModalButton>
  );
}

/** Button → server action with inline result (used for publish toggle & Google sync). */
export function ResultButton({ action, fields, children, className = 'btn secondary sm', confirm }: { action: (fd: FormData) => Promise<ActionResult>; fields: Record<string, string>; children: React.ReactNode; className?: string; confirm?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ActionResult | null>(null);
  return (
    <span className="inline-action">
      <button type="button" className={className} disabled={busy} onClick={async () => {
        if (confirm && !window.confirm(confirm)) return;
        setBusy(true); setRes(null);
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) fd.set(k, v);
        try { setRes(await action(fd)); router.refresh(); } catch (e: any) { setRes({ ok: false, error: e?.message ?? 'エラーが発生しました' }); } finally { setBusy(false); }
      }}>{busy ? <><span className="spinner" /> 処理中…</> : children}</button>
      {res && !res.ok && <span className="form-error" role="alert">{res.error}</span>}
      {res && res.ok && res.message && <span className="form-ok" role="status">{res.message}</span>}
    </span>
  );
}
