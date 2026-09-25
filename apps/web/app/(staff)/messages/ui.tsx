'use client';
// Client widgets for the messaging module.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { renderTemplate, TEMPLATE_VARIABLES } from '@salonos/core';
import type { ActionResult } from '@/lib/server/errors';
import { ActionForm, Modal, SubmitButton } from '@/components/client';
import { searchCustomersAction, sendMessageAction } from './actions';
import { TEMPLATE_CATEGORIES } from './labels';

/** Button → server action (FormData) with optional confirm; shows success and error inline. */
export function InlineAction({ action, fields, confirm, children, className = 'btn secondary sm', showSuccess = true }: {
  action: (fd: FormData) => Promise<ActionResult<any>>; fields?: Record<string, string>; confirm?: string; children: ReactNode; className?: string; showSuccess?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ActionResult<any> | null>(null);
  return (
    <span className="inline-action">
      <button
        type="button" className={className} disabled={busy}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true); setRes(null);
          const fd = new FormData();
          for (const [k, v] of Object.entries(fields ?? {})) fd.set(k, v);
          try {
            const r = await action(fd);
            setRes(r);
            router.refresh();
          } catch (e: any) { setRes({ ok: false, error: e?.message ?? 'エラーが発生しました' }); } finally { setBusy(false); }
        }}
      >{busy ? <span className="spinner" /> : children}</button>
      {res && !res.ok && <span className="form-error" role="alert">{res.error}</span>}
      {res && res.ok && showSuccess && res.message && <span className="form-ok" role="status">{res.message}</span>}
    </span>
  );
}

/** Clickable variable chips that insert {{var}} at the cursor of the target textarea. */
export function VariablePalette({ targetRef, onInsert }: { targetRef: React.RefObject<HTMLTextAreaElement | null>; onInsert: (v: string) => void }) {
  return (
    <div className="var-palette" aria-label="差し込み変数">
      {Object.entries(TEMPLATE_VARIABLES).map(([k, label]) => (
        <button key={k} type="button" className="var-chip" title={`{{${k}}}`} onClick={() => {
          const el = targetRef.current;
          const token = `{{${k}}}`;
          if (!el) return onInsert(token);
          const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? el.value.length;
          const next = el.value.slice(0, s) + token + el.value.slice(e);
          onInsert(next);
          requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + token.length, s + token.length); });
        }}>{label}</button>
      ))}
    </div>
  );
}

export interface TemplateLite { id: string; name: string; category: string; body: string }

export function Composer({ customerId, templates, vars, channels, blockedReason }: {
  customerId: string; templates: TemplateLite[]; vars: Record<string, string>;
  channels: { line: boolean; email: boolean }; blockedReason: string | null;
}) {
  const [body, setBody] = useState('');
  const [templateId, setTemplateId] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const disabled = !!blockedReason;
  return (
    <ActionForm action={sendMessageAction} resetOnSuccess onSuccess={() => { setBody(''); setTemplateId(''); }} className="composer">
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="templateId" value={templateId} />
      {blockedReason && <div className="alert warn" style={{ marginBottom: 8 }}>{blockedReason}</div>}
      <div className="composer-tools">
        <select className="select sm" value="" aria-label="テンプレートを挿入" disabled={disabled || !templates.length} onChange={(e) => {
          const t = templates.find((x) => x.id === e.target.value);
          if (t) { setBody(renderTemplate(t.body, vars)); setTemplateId(t.id); ref.current?.focus(); }
        }}>
          <option value="">{templates.length ? 'テンプレートを挿入…' : 'テンプレートがありません'}</option>
          {templates.map((t) => <option key={t.id} value={t.id}>[{TEMPLATE_CATEGORIES[t.category] ?? t.category}] {t.name}</option>)}
        </select>
        <select name="channel" className="select sm" defaultValue="AUTO" aria-label="送信チャネル" disabled={disabled}>
          <option value="AUTO">自動（LINE優先）</option>
          <option value="LINE" disabled={!channels.line}>LINE{channels.line ? '' : '（不可）'}</option>
          <option value="EMAIL" disabled={!channels.email}>メール{channels.email ? '' : '（不可）'}</option>
        </select>
      </div>
      <div className="composer-row">
        <textarea
          ref={ref} name="body" className="textarea" rows={3} maxLength={5000} placeholder={disabled ? '送信できません' : 'メッセージを入力（Ctrl+Enterで送信）'}
          value={body} onChange={(e) => setBody(e.target.value)} disabled={disabled} required
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
        />
        <SubmitButton pendingText="送信中…" disabled={disabled || !body.trim()}>送信</SubmitButton>
      </div>
      <div className="sub right">{body.length}/5000</div>
    </ActionForm>
  );
}

export function NewThreadButton() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Awaited<ReturnType<typeof searchCustomersAction>>>([]);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      if (!q.trim()) { setRows([]); return; }
      setLoading(true);
      try { setRows(await searchCustomersAction(q)); } finally { setLoading(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q, open]);
  return (
    <>
      <button type="button" className="btn sm" onClick={() => setOpen(true)}>＋ 新規メッセージ</button>
      <Modal open={open} onClose={() => setOpen(false)} title="お客様を選択">
        <input className="input" autoFocus placeholder="氏名・カナで検索" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="list" style={{ marginTop: 8, minHeight: 80 }}>
          {loading && <div className="sub" style={{ padding: 10 }}><span className="spinner" /> 検索中…</div>}
          {!loading && q.trim() && rows.length === 0 && <div className="sub" style={{ padding: 10 }}>該当するお客様がいません</div>}
          {rows.map((r) => (
            <button key={r.id} type="button" className="list-item list-btn" onClick={() => { setOpen(false); router.push(`/messages?customerId=${r.id}`); }}>
              <span className="grow"><strong>{r.name}</strong> <span className="sub">{r.kana}</span></span>
              {r.line ? <span className="badge green">LINE</span> : <span className="badge">LINE未連携</span>}
            </button>
          ))}
        </div>
      </Modal>
    </>
  );
}

/** Body editor with variable palette + live preview (used by templates, broadcasts and rules). */
export function BodyEditor({ name = 'body', defaultValue = '', previewVars, rows = 7, onChange }: {
  name?: string; defaultValue?: string; previewVars: Record<string, string>; rows?: number; onChange?: (v: string) => void;
}) {
  const [body, setBody] = useState(defaultValue);
  const ref = useRef<HTMLTextAreaElement>(null);
  const preview = useMemo(() => renderTemplate(body, previewVars), [body, previewVars]);
  const set = (v: string) => { setBody(v); onChange?.(v); };
  const unknown = useMemo(() => Array.from(body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)).map((m) => m[1]).filter((k) => !(k in TEMPLATE_VARIABLES)), [body]);
  return (
    <div className="body-editor">
      <div className="stack-sm">
        <textarea ref={ref} name={name} className="textarea mono-ish" rows={rows} maxLength={5000} value={body} onChange={(e) => set(e.target.value)} required />
        <VariablePalette targetRef={ref} onInsert={set} />
        {unknown.length > 0 && <div className="form-error">未対応の変数：{unknown.map((u) => `{{${u}}}`).join('、')}</div>}
      </div>
      <div className="preview-phone" aria-label="プレビュー">
        <div className="sub" style={{ marginBottom: 6 }}>プレビュー</div>
        <div className="chat"><div className="bubble out">{preview || <span style={{ opacity: .7 }}>（本文を入力）</span>}</div></div>
      </div>
    </div>
  );
}
