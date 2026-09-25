'use client';
import { useActionState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { ActionResult } from '@/lib/server/errors';
import { SubmitButton } from '@/components/client';
import { submitReviewAction } from './actions';

const LABELS = ['', '不満', 'やや不満', '普通', '満足', 'とても満足'];

export function ReviewForm({ token, defaultName, shopSlug }: { token: string; defaultName: string; shopSlug: string }) {
  const [state, action] = useActionState<ActionResult | null, FormData>(submitReviewAction.bind(null, token), null);
  if (state?.ok) {
    return (
      <div className="card center" style={{ padding: 28 }}>
        <CheckCircle2 size={44} color="var(--green)" style={{ margin: '0 auto 8px' }} />
        <h2>ご投稿ありがとうございました</h2>
        <p className="sub" style={{ marginTop: 6 }}>いただいたご意見はスタッフ一同で拝見し、サービス向上に活かしてまいります。</p>
        <div className="stack-sm" style={{ marginTop: 14 }}>
          <a href={`/book/${shopSlug}`} className="btn block">次回のご予約</a>
          <a href={`/s/${shopSlug}`} className="btn secondary block">サロンのページを見る</a>
        </div>
      </div>
    );
  }
  return (
    <form action={action} className="card stack">
      {state && !state.ok && (
        <div className="alert error" role="alert">{state.error}
          {state.fieldErrors && <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{Object.values(state.fieldErrors).map((v) => <li key={v}>{v}</li>)}</ul>}
        </div>
      )}
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label req" style={{ marginBottom: 6 }}>総合評価</legend>
        <div className="star-input" role="radiogroup" aria-label="総合評価">
          {[5, 4, 3, 2, 1].map((n) => (
            <span key={n} style={{ display: 'contents' }}>
              <input type="radio" id={`star-${n}`} name="rating" value={n} required />
              <label htmlFor={`star-${n}`} title={LABELS[n]} aria-label={`${n}つ星（${LABELS[n]}）`}>★</label>
            </span>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor="title">タイトル</label>
        <input id="title" name="title" className="input" maxLength={80} placeholder="例）いつも丁寧な仕上がりです" />
      </div>
      <div className="field">
        <label htmlFor="body">ご感想</label>
        <textarea id="body" name="body" className="textarea" rows={6} maxLength={2000} placeholder="仕上がり・接客・雰囲気などをお聞かせください" />
      </div>
      <div className="field">
        <label htmlFor="authorName" className="req">表示名（ニックネーム可）</label>
        <input id="authorName" name="authorName" className="input" maxLength={40} defaultValue={defaultName} required />
        <div className="hint">口コミはサロンの公開ページに表示されます。本名以外でも投稿できます。</div>
      </div>
      <SubmitButton className="btn lg block" pendingText="送信中…">口コミを投稿する</SubmitButton>
    </form>
  );
}
