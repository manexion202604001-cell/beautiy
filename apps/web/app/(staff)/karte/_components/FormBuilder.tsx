'use client';
import { useState } from 'react';
import { ArrowUp, ArrowDown, Trash2, Plus, Copy } from 'lucide-react';
import { ActionForm, SubmitButton } from '@/components/client';
import { saveFormAction } from '../actions';

export type FieldType = 'text' | 'textarea' | 'select' | 'multiselect' | 'checkbox' | 'date';
export interface BuilderField { id: string; label: string; type: FieldType; options?: string[]; required?: boolean; help?: string }
export interface BuilderForm { id?: string; name: string; description: string; fields: BuilderField[]; requireConsent: boolean; consentText: string; active: boolean }

const TYPE_LABEL: Record<FieldType, string> = {
  text: '1行テキスト', textarea: '複数行テキスト', select: '単一選択', multiselect: '複数選択', checkbox: 'チェック（はい/いいえ）', date: '日付',
};
const hasOptions = (t: FieldType) => t === 'select' || t === 'multiselect';
const newId = () => `f_${Math.random().toString(36).slice(2, 8)}`;

const PRESETS: { label: string; field: Omit<BuilderField, 'id'> }[] = [
  { label: '髪のお悩み', field: { label: '髪のお悩み', type: 'multiselect', options: ['パサつき', 'うねり・クセ', '白髪', 'ボリューム', '頭皮', '特になし'] } },
  { label: 'アレルギー', field: { label: 'アレルギー・肌トラブルの有無', type: 'select', options: ['なし', 'あり'], required: true } },
  { label: 'なりたいイメージ', field: { label: 'なりたいイメージ・ご要望', type: 'textarea' } },
  { label: '前回のカラー', field: { label: '前回カラーをした時期', type: 'date' } },
  { label: '写真掲載可否', field: { label: 'スタイル写真のSNS掲載に協力できる', type: 'checkbox' } },
];

export function FormBuilder({ initial }: { initial: BuilderForm }) {
  const [f, setF] = useState<BuilderForm>(initial);
  const [preview, setPreview] = useState(false);
  const upd = (patch: Partial<BuilderForm>) => setF((x) => ({ ...x, ...patch }));
  const updField = (i: number, patch: Partial<BuilderField>) => setF((x) => ({ ...x, fields: x.fields.map((fl, j) => (j === i ? { ...fl, ...patch } : fl)) }));
  const move = (i: number, d: -1 | 1) => setF((x) => {
    const j = i + d;
    if (j < 0 || j >= x.fields.length) return x;
    const arr = [...x.fields];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    return { ...x, fields: arr };
  });
  const add = (field?: Omit<BuilderField, 'id'>) => setF((x) => ({ ...x, fields: [...x.fields, { id: newId(), label: '', type: 'text', ...field }] }));

  const payload = JSON.stringify({
    name: f.name, description: f.description || null, requireConsent: f.requireConsent, consentText: f.consentText || null, active: f.active,
    fields: f.fields.map((x) => ({
      id: x.id, label: x.label, type: x.type, required: !!x.required, ...(x.help?.trim() ? { help: x.help.trim() } : {}),
      ...(hasOptions(x.type) ? { options: (x.options ?? []).map((o) => o.trim()).filter(Boolean) } : {}),
    })),
  });

  return (
    <ActionForm action={saveFormAction}>
      {f.id && <input type="hidden" name="id" value={f.id} />}
      <input type="hidden" name="payload" value={payload} />
      <div className="stack">
        <div className="card">
          <div className="form-grid">
            <div className="field"><label htmlFor="fb-name" className="req">フォーム名</label><input id="fb-name" className="input" value={f.name} onChange={(e) => upd({ name: e.target.value })} maxLength={80} placeholder="例: 初回カウンセリングシート" required /></div>
            <div className="field" style={{ justifyContent: 'flex-end' }}>
              <label className="checkbox"><input type="checkbox" checked={f.active} onChange={(e) => upd({ active: e.target.checked })} />公開中（記入リンクを発行できる）</label>
            </div>
            <div className="field full"><label htmlFor="fb-desc">説明（お客様に表示）</label><textarea id="fb-desc" className="textarea" rows={2} value={f.description} onChange={(e) => upd({ description: e.target.value })} maxLength={1000} placeholder="例: ご来店前にご記入ください。所要時間は約3分です。" /></div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>質問項目 <span className="sub">（{f.fields.length}）</span></h2>
            <button type="button" className="btn ghost sm" onClick={() => setPreview((p) => !p)}>{preview ? '編集に戻る' : 'プレビュー'}</button>
          </div>
          {preview ? <Preview form={f} /> : (
            <>
              {f.fields.length === 0 && <p className="sub">項目がありません。下のボタンから追加してください。</p>}
              <ol className="fb-list">
                {f.fields.map((x, i) => (
                  <li key={x.id} className="fb-item">
                    <div className="fb-order">
                      <button type="button" className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="上へ"><ArrowUp size={14} /></button>
                      <span className="sub">{i + 1}</span>
                      <button type="button" className="icon-btn" onClick={() => move(i, 1)} disabled={i === f.fields.length - 1} aria-label="下へ"><ArrowDown size={14} /></button>
                    </div>
                    <div className="fb-body">
                      <div className="form-grid">
                        <div className="field"><label htmlFor={`${x.id}-l`} className="req">質問</label><input id={`${x.id}-l`} className="input" value={x.label} onChange={(e) => updField(i, { label: e.target.value })} maxLength={120} placeholder="質問文" /></div>
                        <div className="field">
                          <label htmlFor={`${x.id}-t`}>回答形式</label>
                          <select id={`${x.id}-t`} className="select" value={x.type} onChange={(e) => updField(i, { type: e.target.value as FieldType, options: hasOptions(e.target.value as FieldType) ? (x.options?.length ? x.options : ['選択肢1', '選択肢2']) : x.options })}>
                            {(Object.keys(TYPE_LABEL) as FieldType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                          </select>
                        </div>
                        {hasOptions(x.type) && (
                          <div className="field full">
                            <label htmlFor={`${x.id}-o`} className="req">選択肢（1行に1つ）</label>
                            <textarea id={`${x.id}-o`} className="textarea" rows={Math.min(8, Math.max(3, (x.options?.length ?? 0) + 1))} value={(x.options ?? []).join('\n')} onChange={(e) => updField(i, { options: e.target.value.split('\n').slice(0, 50) })} />
                          </div>
                        )}
                        <div className="field full"><label htmlFor={`${x.id}-h`}>補足（任意）</label><input id={`${x.id}-h`} className="input" value={x.help ?? ''} onChange={(e) => updField(i, { help: e.target.value })} maxLength={300} /></div>
                      </div>
                      <div className="between" style={{ marginTop: 8 }}>
                        <label className="checkbox"><input type="checkbox" checked={!!x.required} onChange={(e) => updField(i, { required: e.target.checked })} />必須</label>
                        <div className="row" style={{ gap: 4 }}>
                          <button type="button" className="btn ghost sm" onClick={() => setF((s) => ({ ...s, fields: [...s.fields.slice(0, i + 1), { ...x, id: newId(), label: `${x.label}（コピー）` }, ...s.fields.slice(i + 1)] }))}><Copy size={13} />複製</button>
                          <button type="button" className="btn ghost sm" onClick={() => setF((s) => ({ ...s, fields: s.fields.filter((_, j) => j !== i) }))}><Trash2 size={13} />削除</button>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="row-wrap section">
                <button type="button" className="btn secondary sm" onClick={() => add()}><Plus size={14} />項目を追加</button>
                <span className="sub">よく使う項目:</span>
                {PRESETS.map((p) => <button key={p.label} type="button" className="btn ghost sm" onClick={() => add(p.field)}>＋{p.label}</button>)}
              </div>
            </>
          )}
        </div>

        <div className="card">
          <div className="card-head"><h2>同意・電子署名</h2></div>
          <label className="checkbox"><input type="checkbox" checked={f.requireConsent} onChange={(e) => upd({ requireConsent: e.target.checked })} />同意と署名を必須にする（施術同意書として利用）</label>
          {f.requireConsent && (
            <div className="field section">
              <label htmlFor="fb-consent" className="req">同意文</label>
              <textarea id="fb-consent" className="textarea" rows={5} value={f.consentText} onChange={(e) => upd({ consentText: e.target.value })} maxLength={5000} placeholder="例: 薬剤によるアレルギー反応が起こる可能性があることを理解し、施術に同意します。" />
              <div className="hint">お客様は同意にチェックし、手書きサインと氏名を入力して送信します。</div>
            </div>
          )}
        </div>

        <div className="form-actions"><SubmitButton pendingText="保存中…">{f.id ? 'フォームを保存' : 'フォームを作成'}</SubmitButton></div>
      </div>
    </ActionForm>
  );
}

function Preview({ form }: { form: BuilderForm }) {
  return (
    <div className="fb-preview">
      <h3>{form.name || '（フォーム名）'}</h3>
      {form.description && <p className="sub">{form.description}</p>}
      {form.fields.map((x) => (
        <div key={x.id} className="field" style={{ marginBottom: 12 }}>
          <label className={x.required ? 'req' : ''}>{x.label || '（質問）'}</label>
          {x.help && <div className="hint">{x.help}</div>}
          {x.type === 'text' && <input className="input" disabled />}
          {x.type === 'textarea' && <textarea className="textarea" rows={2} disabled />}
          {x.type === 'date' && <input className="input" type="date" disabled />}
          {x.type === 'checkbox' && <label className="checkbox"><input type="checkbox" disabled />はい</label>}
          {x.type === 'select' && <div className="row-wrap">{(x.options ?? []).filter(Boolean).map((o) => <label key={o} className="checkbox"><input type="radio" disabled />{o}</label>)}</div>}
          {x.type === 'multiselect' && <div className="row-wrap">{(x.options ?? []).filter(Boolean).map((o) => <label key={o} className="checkbox"><input type="checkbox" disabled />{o}</label>)}</div>}
        </div>
      ))}
      {form.requireConsent && <div className="alert info">同意文・同意チェック・署名欄・氏名欄が表示されます</div>}
    </div>
  );
}
