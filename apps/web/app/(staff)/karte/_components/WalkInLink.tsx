'use client';
import { useState } from 'react';
import { ActionForm, CopyButton, SubmitButton } from '@/components/client';
import { issueWalkInLinkAction } from '../actions';

/** Issue an anonymous self-entry link (e.g. for walk-ins / a reception tablet). */
export function WalkInLink({ formId }: { formId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  return (
    <ActionForm<{ url: string }> action={issueWalkInLinkAction} onSuccess={(r) => r.ok && setUrl(r.data?.url ?? null)} showSuccess={false}>
      <input type="hidden" name="formId" value={formId} />
      <p className="sub" style={{ marginTop: 0 }}>顧客を指定しない記入リンクを発行します（受付タブレットや新規のお客様向け）。顧客ごとの依頼は顧客詳細の「カウンセリング依頼」から行えます。</p>
      {url && (
        <div className="row" style={{ alignItems: 'stretch', marginBottom: 10 }}>
          <input className="input sm mono" readOnly value={url} onFocus={(e) => e.target.select()} aria-label="記入リンク" />
          <CopyButton text={url} />
          <a className="btn secondary sm" href={url} target="_blank" rel="noreferrer">開く</a>
        </div>
      )}
      <SubmitButton className="btn secondary sm">{url ? '別のリンクを発行' : '記入リンクを発行'}</SubmitButton>
    </ActionForm>
  );
}
