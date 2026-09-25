'use client';
// Client helpers for settings screens (server pages pass server actions + server-rendered fields).
import { useState, type ReactNode } from 'react';
import { ActionForm, CopyButton, Modal, SubmitButton } from '@/components/client';
import type { ActionResult } from '@/lib/server/errors';

type Act<T = any> = (prev: ActionResult<T> | null, fd: FormData) => Promise<ActionResult<T>>;

/** Button → modal with an ActionForm; closes on success. */
export function FormModal({ label, title, action, children, className = 'btn', wide, submitLabel = '保存', danger }: {
  label: ReactNode; title: ReactNode; action: Act; children: ReactNode; className?: string; wide?: boolean; submitLabel?: string; danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>{label}</button>
      <Modal open={open} onClose={() => setOpen(false)} title={title} wide={wide}>
        {open && (
          <ActionForm action={action} onSuccess={() => setOpen(false)} showSuccess={false}>
            {children}
            <div className="form-actions">
              <button type="button" className="btn secondary" onClick={() => setOpen(false)}>キャンセル</button>
              <SubmitButton className={danger ? 'btn danger' : 'btn'}>{submitLabel}</SubmitButton>
            </div>
          </ActionForm>
        )}
      </Modal>
    </>
  );
}

export interface Reveal { reveal?: string; revealLabel?: string; revealNote?: string }

/** Button → modal whose action returns a one-time value (invite URL, generated secret) to copy. */
export function RevealModal({ label, title, action, children, className = 'btn', submitLabel = '作成', wide }: {
  label: ReactNode; title: ReactNode; action: Act<Reveal>; children: ReactNode; className?: string; submitLabel?: string; wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Reveal | null>(null);
  const close = () => { setOpen(false); setResult(null); };
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>{label}</button>
      <Modal open={open} onClose={close} title={title} wide={wide}>
        {result?.reveal ? (
          <div className="stack">
            <div className="alert success">{result.revealLabel ?? '作成しました'}</div>
            <div className="url-box"><input className="input" readOnly value={result.reveal} onFocus={(e) => e.currentTarget.select()} aria-label={result.revealLabel ?? '値'} /><CopyButton text={result.reveal} /></div>
            <p className="sub">{result.revealNote ?? 'この値は再表示できません。今すぐコピーして安全な方法で共有してください。'}</p>
            <div className="form-actions"><button type="button" className="btn" onClick={close}>閉じる</button></div>
          </div>
        ) : open && (
          <ActionForm<Reveal> action={action} onSuccess={(r) => r.ok && setResult(r.data ?? null)} showSuccess={false}>
            {children}
            <div className="form-actions">
              <button type="button" className="btn secondary" onClick={close}>キャンセル</button>
              <SubmitButton>{submitLabel}</SubmitButton>
            </div>
          </ActionForm>
        )}
      </Modal>
    </>
  );
}

/** Inline form whose result message stays visible (e.g. connection tests). */
export function InlineAction({ action, children, fields, className = 'btn secondary sm' }: { action: Act; children: ReactNode; fields: Record<string, string>; className?: string }) {
  return (
    <ActionForm action={action} className="inline-action">
      {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <SubmitButton className={className}>{children}</SubmitButton>
    </ActionForm>
  );
}
