'use client';
// ActionForm variant that does NOT trigger React 19's automatic form reset.
// React resets a <form action={fn}> after every submission, which desyncs controlled
// checkboxes/radios (DOM unchecked while state says checked) and wipes uncontrolled input
// after a validation error. Here the action is dispatched from onSubmit inside a transition.
import { createContext, useActionState, useContext, useEffect, useRef, startTransition, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult } from '@/lib/server/errors';

type Action<T> = (prev: ActionResult<T> | null, fd: FormData) => Promise<ActionResult<T>>;

const PendingCtx = createContext(false);

export function StableActionForm<T = unknown>({
  action, children, className, onSuccess, successMessage, showSuccess = true, refresh = true, resetOnSuccess, id,
}: {
  action: Action<T>; children: ReactNode; className?: string; onSuccess?: (r: ActionResult<T>) => void;
  successMessage?: string; showSuccess?: boolean; refresh?: boolean; resetOnSuccess?: boolean; id?: string;
}) {
  const [state, dispatch, pending] = useActionState<ActionResult<T> | null, FormData>(action, null);
  const router = useRouter();
  const ref = useRef<HTMLFormElement>(null);
  const last = useRef<ActionResult<T> | null>(null);
  useEffect(() => {
    if (!state || state === last.current) return;
    last.current = state;
    if (state.ok) {
      if (resetOnSuccess) ref.current?.reset();
      if (refresh) router.refresh();
      onSuccess?.(state);
    }
  }, [state, onSuccess, refresh, resetOnSuccess, router]);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter ?? undefined);
    startTransition(() => dispatch(fd));
  };
  return (
    <form ref={ref} onSubmit={submit} className={className} id={id} aria-busy={pending}>
      {state && !state.ok && (
        <div className="alert error" role="alert" style={{ marginBottom: 12 }}>
          {state.error}
          {state.fieldErrors && Object.keys(state.fieldErrors).length > 0 && <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{Object.entries(state.fieldErrors).map(([k, v]) => <li key={k}>{v}</li>)}</ul>}
        </div>
      )}
      {state && state.ok && showSuccess && (state.message || successMessage) && <div className="alert success" role="status" style={{ marginBottom: 12 }}>{state.message ?? successMessage}</div>}
      <PendingCtx.Provider value={pending}>{children}</PendingCtx.Provider>
    </form>
  );
}

/** Submit button aware of the enclosing StableActionForm's pending state. */
export function StableSubmit({ children, className = 'btn', pendingText, disabled }: { children: ReactNode; className?: string; pendingText?: string; disabled?: boolean }) {
  const pending = useContext(PendingCtx);
  return (
    <button type="submit" className={className} disabled={pending || disabled} aria-busy={pending}>
      {pending ? <><span className="spinner" /> {pendingText ?? '処理中…'}</> : children}
    </button>
  );
}
