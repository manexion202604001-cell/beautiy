'use client';
import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Copy, FileText } from 'lucide-react';
import { StableActionForm, StableSubmit } from '../../customers/_components/StableActionForm';
import { saveKarteAction } from '../actions';
import { SketchCanvas, EMPTY_SKETCH, type Sketch } from './SketchCanvas';
import { useDictation } from './useDictation';

type FieldKey = 'treatmentNote' | 'formulaNote' | 'assistantNote' | 'careMemo';
type Fields = Record<FieldKey, string>;

const FIELD_META: { key: FieldKey; label: string; hint: string; placeholder: string; rows: number; badge?: string }[] = [
  { key: 'treatmentNote', label: '施術内容', hint: 'カット・スタイリングの内容、仕上がり、お客様の反応など', placeholder: '例: 全体2cmカット、顔周りにレイヤー。次回は前髪を少し長めに。', rows: 5 },
  { key: 'formulaNote', label: '薬剤・レシピ', hint: '薬剤名・配合比率・放置時間など（次回の再現用）', placeholder: '例: 根元 7N 40g + OX6% 1:1 / 20分\n毛先 7Ash 30g + OX3%', rows: 4, badge: '社内' },
  { key: 'assistantNote', label: 'アシスタントメモ', hint: 'シャンプー・ヘッドスパ・申し送り事項など', placeholder: '例: シャンプー時に頭皮の乾燥あり。お湯はぬるめ希望。', rows: 3, badge: '社内' },
  { key: 'careMemo', label: 'お客様へのケアメモ', hint: '共有ページでお客様に表示されます', placeholder: '例: カラー後2日間はシャンプーを控えめに。次回は6〜7週間後がおすすめです。', rows: 4, badge: 'お客様に表示' },
];

export interface TemplateOption { id: string; name: string; treatmentNote: string | null; formulaNote: string | null; careMemo: string | null }
export interface PreviousKarte { id: string; visitDate: string; treatmentNote: string | null; formulaNote: string | null; assistantNote: string | null; careMemo: string | null }

export function KarteEditor({
  karteId, customerId, appointmentId, visitDate, initial, sketch, templates, previous, readOnly,
}: {
  karteId?: string; customerId: string; appointmentId?: string | null; visitDate: string;
  initial: Fields; sketch: Sketch | null; templates: TemplateOption[]; previous: PreviousKarte | null; readOnly?: boolean;
}) {
  const [fields, setFields] = useState<Fields>(initial);
  const [date, setDate] = useState(visitDate);
  const [sk, setSk] = useState<Sketch>(sketch ?? EMPTY_SKETCH);
  const [active, setActive] = useState<FieldKey>('treatmentNote');
  const [tpl, setTpl] = useState('');
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const refs = useRef<Partial<Record<FieldKey, HTMLTextAreaElement | null>>>({});

  const set = (k: FieldKey, v: string) => { setFields((f) => ({ ...f, [k]: v })); setDirty(true); };
  const dictation = useDictation((text) => {
    setFields((f) => {
      const cur = f[active];
      const sep = cur && !/[\s\n]$/.test(cur) ? (/[。．.!?！？]$/.test(cur) ? '\n' : '、') : '';
      return { ...f, [active]: cur + sep + text.trim() };
    });
    setDirty(true);
  });

  useEffect(() => {
    if (!dirty || readOnly) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty, readOnly]);

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(null), 2500); };

  const applyTemplate = () => {
    const t = templates.find((x) => x.id === tpl);
    if (!t) return;
    setFields((f) => {
      const merge = (cur: string, add: string | null) => (!add ? cur : !cur.trim() ? add : `${cur.replace(/\s+$/, '')}\n${add}`);
      return { ...f, treatmentNote: merge(f.treatmentNote, t.treatmentNote), formulaNote: merge(f.formulaNote, t.formulaNote), careMemo: merge(f.careMemo, t.careMemo) };
    });
    setDirty(true);
    setTpl('');
    flash(`テンプレート「${t.name}」を挿入しました`);
  };

  const copyPrevious = () => {
    if (!previous) return;
    const hasText = Object.values(fields).some((v) => v.trim());
    if (hasText && !window.confirm('入力中の内容を前回のカルテで上書きしますか？')) return;
    setFields({ treatmentNote: previous.treatmentNote ?? '', formulaNote: previous.formulaNote ?? '', assistantNote: previous.assistantNote ?? '', careMemo: previous.careMemo ?? '' });
    setDirty(true);
    flash(`${previous.visitDate} のカルテをコピーしました`);
  };

  const activeLabel = FIELD_META.find((m) => m.key === active)?.label;

  return (
    <StableActionForm action={saveKarteAction} onSuccess={() => setDirty(false)} className="stack">
      {karteId && <input type="hidden" name="id" value={karteId} />}
      <input type="hidden" name="customerId" value={customerId} />
      {appointmentId && <input type="hidden" name="appointmentId" value={appointmentId} />}
      <input type="hidden" name="sketchJson" value={JSON.stringify(sk)} />

      {!readOnly && (
        <div className="card kt-toolbar">
          <div className="field" style={{ width: 160 }}>
            <label htmlFor="visitDate">来店日</label>
            <input id="visitDate" name="visitDate" type="date" className="input sm" value={date} onChange={(e) => { setDate(e.target.value); setDirty(true); }} required />
          </div>
          <div className="row" style={{ gap: 6, alignItems: 'flex-end' }}>
            <div className="field">
              <label htmlFor="tpl">テンプレート</label>
              <select id="tpl" className="select sm" value={tpl} onChange={(e) => setTpl(e.target.value)} disabled={!templates.length} style={{ minWidth: 170 }}>
                <option value="">{templates.length ? '選択してください' : 'テンプレートなし'}</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <button type="button" className="btn secondary sm" onClick={applyTemplate} disabled={!tpl}><FileText size={14} />挿入</button>
          </div>
          <button type="button" className="btn secondary sm" onClick={copyPrevious} disabled={!previous} title={previous ? `${previous.visitDate} のカルテ` : '前回のカルテがありません'}>
            <Copy size={14} />前回のカルテをコピー{previous && <span className="sub">（{previous.visitDate}）</span>}
          </button>
          <span className="spacer" />
          <div className="stack-sm" style={{ alignItems: 'flex-end' }}>
            <button
              type="button"
              className={`btn sm ${dictation.listening ? 'danger' : 'secondary'}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={dictation.toggle}
              disabled={!dictation.supported}
              title={dictation.supported ? `「${activeLabel}」に音声で入力` : 'このブラウザは音声入力に対応していません'}
              aria-pressed={dictation.listening}
            >
              {dictation.listening ? <><MicOff size={14} />停止</> : <><Mic size={14} />音声入力</>}
            </button>
            <span className="sub" style={{ fontSize: 11 }}>{dictation.supported ? (dictation.listening ? `「${activeLabel}」に入力中…` : `入力先: ${activeLabel}`) : '音声入力は非対応のブラウザです'}</span>
          </div>
        </div>
      )}
      {readOnly && <input type="hidden" name="visitDate" value={date} />}
      {dictation.error && <div className="alert warn">{dictation.error}</div>}
      {notice && <div className="alert info" role="status">{notice}</div>}

      <div className="kt-fields">
        {FIELD_META.map((m) => (
          <div key={m.key} className={`field kt-field ${active === m.key && dictation.listening ? 'kt-listening' : ''}`}>
            <label htmlFor={m.key} className="between">
              <span>{m.label}{m.badge && <span className={`badge ${m.key === 'careMemo' ? 'green' : ''}`} style={{ marginLeft: 6 }}>{m.badge}</span>}</span>
            </label>
            <textarea
              id={m.key} name={m.key} ref={(el) => { refs.current[m.key] = el; }}
              className="textarea" rows={m.rows} maxLength={10000} value={fields[m.key]} placeholder={readOnly ? '' : m.placeholder}
              onChange={(e) => set(m.key, e.target.value)} onFocus={() => setActive(m.key)} readOnly={readOnly}
            />
            {active === m.key && dictation.listening && dictation.interim && <div className="hint kt-interim">🎙 {dictation.interim}</div>}
            {!readOnly && <div className="hint">{m.hint}</div>}
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-head"><h2>スケッチ</h2><span className="sub">{readOnly ? '' : '指・Apple Pencil・マウスで描けます'}</span></div>
        <SketchCanvas value={sk} onChange={readOnly ? undefined : (v) => { setSk(v); setDirty(true); }} readOnly={readOnly} />
      </div>

      {!readOnly && (
        <div className="kt-savebar">
          <span className="sub">{dirty ? '未保存の変更があります' : karteId ? '保存済み' : ''}</span>
          <StableSubmit pendingText="保存中…">{karteId ? 'カルテを保存' : 'カルテを作成'}</StableSubmit>
        </div>
      )}
    </StableActionForm>
  );
}
