'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult } from '@/lib/server/errors';

/** Runs a server action, then navigates (to the returned id, or a fixed href). */
export function NavAction({ fields, action, label, confirm, className = 'btn secondary sm', to }: {
  fields: Record<string, string>; action: (fd: FormData) => Promise<ActionResult<any>>; label: string; confirm?: string; className?: string;
  to: { href: string } | { prefix: string };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="inline-action">
      <button type="button" className={className} disabled={busy} onClick={async () => {
        if (confirm && !window.confirm(confirm)) return;
        setBusy(true); setErr(null);
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) fd.set(k, v);
        const r = await action(fd).catch((e) => ({ ok: false as const, error: String(e?.message ?? e) }));
        setBusy(false);
        if (!r.ok) { setErr(r.error); return; }
        router.push('href' in to ? to.href : `${to.prefix}${r.data?.id ?? ''}`);
        router.refresh();
      }}>{busy ? <span className="spinner" /> : label}</button>
      {err && <span className="form-error">{err}</span>}
    </span>
  );
}
