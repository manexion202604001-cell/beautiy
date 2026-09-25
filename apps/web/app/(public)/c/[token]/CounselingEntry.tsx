'use client';
import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { CheckCircle2, Eraser } from 'lucide-react';
import type { ActionResult } from '@/lib/server/errors';
import { submitCounselingAction } from './actions';

type FieldType = 'text' | 'textarea' | 'select' | 'multiselect' | 'checkbox' | 'date';
interface Field { id: string; label: string; type: FieldType; options?: string[]; required?: boolean; help?: string }
interface Form { name: string; description: string | null; fields: Field[]; requireConsent: boolean; consentText: string | null }

export function CounselingEntry({ token, form, intro }: { token: string; form: Form; intro: string | null }) {
  const action = useMemo(() => submitCounselingAction.bind(null, token), [token]);
  const [state, formAction] = useActionState<ActionResult | null, FormData>(action, null);
  const [values, setValues] = useState<Record<string, string | string[] | boolean>>({});
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState('');
  const [sig, setSig] = useState('');
  const errs = state && !state.ok ? state.fieldErrors ?? {} : {};
  const topRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state && !state.ok) {
      const first = Object.keys(state.fieldErrors ?? {})[0];
      const el = first ? document.getElementById(first.startsWith('_') ? first.slice(1) : `q-${first}`) : topRef.current;
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (state?.ok) window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [state]);

  if (state?.ok) {
    return (
      <section className="card center" style={{ padding: '36px 20px' }}>
        <CheckCircle2 size={44} color="var(--green)" />
        <h1 style={{ fontSize: 20, margin: '10px 0 6px' }}>ご回答ありがとうございました</h1>
        <p className="sub" style={{ margin: 0 }}>内容はサロンに送信されました。ご来店を心よりお待ちしております。<br />このページは閉じていただいて問題ありません。</p>
      </section>
    );
  }

  const set = (id: string, v: string | string[] | boolean) => setValues((s) => ({ ...s, [id]: v }));

  return (
    <form action={formAction} className="stack" noValidate>
      <div ref={topRef} />
      <section className="card">
        <h1 style={{ fontSize: 20 }}>{form.name}</h1>
        {form.description && <p className="sub" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{form.description}</p>}
        {intro && <p className="sub" style={{ margin: '6px 0 0' }}>{intro}</p>}
      </section>

      {state && !state.ok && <div className="alert error" role="alert">{state.error}</div>}

      <section className="card stack cf-fields">
        {form.fields.map((f) => {
          const name = `f_${f.id}`;
          const err = errs[f.id];
          const v = values[f.id];
          return (
            <fieldset key={f.id} id={`q-${f.id}`} className={`cf-q ${err ? 'has-error' : ''}`}>
              <legend className={f.required ? 'req' : ''}>{f.label}</legend>
              {f.help && <div className="hint">{f.help}</div>}
              {f.type === 'text' && <input className="input" name={name} value={(v as string) ?? ''} onChange={(e) => set(f.id, e.target.value)} maxLength={500} aria-invalid={!!err} />}
              {f.type === 'textarea' && <textarea className="textarea" name={name} rows={3} value={(v as string) ?? ''} onChange={(e) => set(f.id, e.target.value)} maxLength={3000} aria-invalid={!!err} />}
              {f.type === 'date' && <input className="input" type="date" name={name} value={(v as string) ?? ''} onChange={(e) => set(f.id, e.target.value)} aria-invalid={!!err} />}
              {f.type === 'checkbox' && <label className="cf-choice"><input type="checkbox" name={name} checked={!!v} onChange={(e) => set(f.id, e.target.checked)} />はい</label>}
              {f.type === 'select' && (
                <div className="cf-options">
                  {(f.options ?? []).map((o) => (
                    <label key={o} className={`cf-choice ${v === o ? 'on' : ''}`}><input type="radio" name={name} value={o} checked={v === o} onChange={() => set(f.id, o)} />{o}</label>
                  ))}
                </div>
              )}
              {f.type === 'multiselect' && (
                <div className="cf-options">
                  {(f.options ?? []).map((o) => {
                    const arr = (v as string[] | undefined) ?? [];
                    const on = arr.includes(o);
                    return <label key={o} className={`cf-choice ${on ? 'on' : ''}`}><input type="checkbox" name={name} value={o} checked={on} onChange={() => set(f.id, on ? arr.filter((x) => x !== o) : [...arr, o])} />{o}</label>;
                  })}
                </div>
              )}
              {err && <div className="form-error">{err}</div>}
            </fieldset>
          );
        })}
      </section>

      {form.requireConsent && (
        <section className="card stack">
          <h2>同意事項</h2>
          {form.consentText && <div className="cf-consent">{form.consentText}</div>}
          <label id="consent" className={`cf-choice ${consent ? 'on' : ''}`}><input type="checkbox" name="consent" checked={consent} onChange={(e) => setConsent(e.target.checked)} />上記の内容を確認し、同意します</label>
          {errs._consent && <div className="form-error">{errs._consent}</div>}
          <div id="signature">
            <div className="label" style={{ marginBottom: 6 }}>署名（指でなぞってご記入ください）</div>
            <SignaturePad onChange={setSig} />
            <input type="hidden" name="signatureData" value={sig} />
            {errs._signature && <div className="form-error">{errs._signature}</div>}
          </div>
          <div className="field" id="signedName">
            <label htmlFor="cf-name" className="req">お名前（フルネーム）</label>
            <input id="cf-name" className="input" name="signedName" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="name" />
            {errs._signedName && <div className="form-error">{errs._signedName}</div>}
          </div>
        </section>
      )}
      {!form.requireConsent && <input type="hidden" name="signedName" value="" />}

      <Submit />
      <p className="sub center">ご入力内容はサロンのスタッフのみが確認し、施術のご提案に利用します。</p>
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return <button type="submit" className="btn lg block" disabled={pending}>{pending ? <><span className="spinner" /> 送信中…</> : '回答を送信する'}</button>;
}

/** Touch/pen/mouse signature capture → PNG data URL (white background, max 2x density). */
function SignaturePad({ onChange }: { onChange: (dataUrl: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<[number, number] | null>(null);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const cv = ref.current!;
    const setup = () => {
      const w = cv.clientWidth, h = cv.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      const ctx = cv.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#0d1830'; ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      setEmpty(true); onChange('');
    };
    setup();
    let lastW = cv.clientWidth;
    const ro = new ResizeObserver(() => { if (cv.clientWidth !== lastW) { lastW = cv.clientWidth; setup(); } });
    ro.observe(cv);
    return () => ro.disconnect();
  }, [onChange]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pos(e);
    const ctx = e.currentTarget.getContext('2d')!;
    ctx.beginPath(); ctx.arc(last.current[0], last.current[1], 1.2, 0, Math.PI * 2); ctx.fillStyle = '#0d1830'; ctx.fill();
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return;
    const ctx = e.currentTarget.getContext('2d')!;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.current[0], last.current[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
    last.current = p;
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    setEmpty(false);
    onChange(ref.current!.toDataURL('image/png'));
  };
  const clear = () => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d')!;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.restore();
    setEmpty(true); onChange('');
  };
  return (
    <div className="cf-sign">
      <canvas ref={ref} className="canvas-box" style={{ height: 170 }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-label="署名欄" role="img" />
      {empty && <span className="cf-sign-ph" aria-hidden>ここにサイン</span>}
      <button type="button" className="btn ghost sm cf-sign-clear" onClick={clear}><Eraser size={13} />書き直す</button>
    </div>
  );
}
