'use client';
// Client interaction primitives shared across modules.
import { createContext, startTransition, useActionState, useContext, useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import type { ActionResult } from '@/lib/server/errors';

const ActionPendingCtx = createContext(false);

export function SubmitButton({ children, className = 'btn', pendingText, disabled, name, value, formAction }: { children: ReactNode; className?: string; pendingText?: string; disabled?: boolean; name?: string; value?: string; formAction?: (fd: FormData) => void }) {
  const status = useFormStatus();
  const ctxPending = useContext(ActionPendingCtx);
  const pending = status.pending || ctxPending;
  return (
    <button type="submit" className={className} disabled={pending || disabled} aria-busy={pending} name={name} value={value} formAction={formAction}>
      {pending ? <><span className="spinner" /> {pendingText ?? '処理中…'}</> : children}
    </button>
  );
}

type Action<T = any> = (prev: ActionResult<T> | null, fd: FormData) => Promise<ActionResult<T>>;

/**
 * Form bound to a server action returning ActionResult. Shows error/success,
 * optionally resets, refreshes or calls onSuccess.
 */
export function ActionForm<T = any>({
  action, children, className, resetOnSuccess, onSuccess, successMessage, id, showSuccess = true, refresh = true,
}: {
  action: Action<T>; children: ReactNode; className?: string; resetOnSuccess?: boolean;
  onSuccess?: (r: ActionResult<T>) => void; successMessage?: string; id?: string; showSuccess?: boolean; refresh?: boolean;
}) {
  const [state, dispatch, pending] = useActionState<ActionResult<T> | null, FormData>(action, null);
  const [refreshing, startRefresh] = useTransition();
  const ref = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const last = useRef<ActionResult<T> | null>(null);
  const awaitingRefresh = useRef<ActionResult<T> | null>(null);
  useEffect(() => {
    if (!state || state === last.current) return;
    last.current = state;
    if (!state.ok) return;
    if (resetOnSuccess) ref.current?.reset();
    if (refresh) {
      // Keep this form mounted until the refreshed page has committed, then run onSuccess
      // (which often closes the modal). Unmounting mid-refresh can drop the refresh.
      awaitingRefresh.current = state;
      startRefresh(() => router.refresh());
    } else onSuccess?.(state);
  }, [state, resetOnSuccess, onSuccess, router, refresh]);
  useEffect(() => {
    if (refreshing || !awaitingRefresh.current) return;
    const r = awaitingRefresh.current;
    awaitingRefresh.current = null;
    onSuccess?.(r);
  }, [refreshing, onSuccess]);
  // Dispatch from onSubmit (not <form action>) so React 19 does not auto-reset the form:
  // auto-reset desyncs controlled checkboxes and wipes input after a validation error.
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending || refreshing) return;
    const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter ?? undefined);
    startTransition(() => dispatch(fd));
  };
  return (
    <form ref={ref} onSubmit={submit} className={className} id={id} aria-busy={pending}>
      {state && !state.ok && <div className="alert error" role="alert" style={{ marginBottom: 12 }}>{state.error}{state.fieldErrors && Object.keys(state.fieldErrors).length > 0 && <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{Object.entries(state.fieldErrors).map(([k, v]) => <li key={k}>{v}</li>)}</ul>}</div>}
      {state && state.ok && showSuccess && (state.message || successMessage) && <div className="alert success" role="status" style={{ marginBottom: 12 }}>{state.message ?? successMessage}</div>}
      <ActionPendingCtx.Provider value={pending || refreshing}>{children}</ActionPendingCtx.Provider>
    </form>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head"><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="閉じる"><X size={16} /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head"><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="閉じる"><X size={16} /></button></div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </div>
  );
}

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
}

/** Button that opens a modal containing arbitrary content (e.g. an ActionForm). */
export function ModalButton({ label, title, children, className = 'btn', wide }: { label: ReactNode; title: ReactNode; children: (close: () => void) => ReactNode; className?: string; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>{label}</button>
      <Modal open={open} onClose={() => setOpen(false)} title={title} wide={wide}>{children(() => setOpen(false))}</Modal>
    </>
  );
}

/** Small inline form posting to a server action with a confirm() prompt. */
export function ConfirmAction({ action, confirm, children, className = 'btn secondary sm', fields }: { action: (fd: FormData) => Promise<unknown>; confirm?: string; children: ReactNode; className?: string; fields?: Record<string, string> }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <button
        type="button" className={className} disabled={busy}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true); setErr(null);
          const fd = new FormData();
          for (const [k, v] of Object.entries(fields ?? {})) fd.set(k, v);
          try {
            const r: any = await action(fd);
            if (r && r.ok === false) setErr(r.error);
            router.refresh();
          } catch (e: any) { setErr(e?.message ?? 'エラーが発生しました'); } finally { setBusy(false); }
        }}
      >{busy ? <span className="spinner" /> : children}</button>
      {err && <span className="form-error">{err}</span>}
    </span>
  );
}

export function CopyButton({ text, label = 'コピー' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn secondary sm" onClick={async () => { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      {done ? 'コピーしました' : label}
    </button>
  );
}
