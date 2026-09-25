// Server-safe presentational primitives.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { initials } from '@/lib/format';

export function PageHeader({ title, sub, actions, back }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="page-head">
      <div>
        {back && <Link href={back.href} className="sub link">← {back.label}</Link>}
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions && <div className="toolbar">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = '', flush }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={`card ${flush ? 'flush' : ''} ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions && <div className="toolbar">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'up' | 'down' }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className={`delta ${tone ?? ''} sub`}>{sub}</div>}
    </div>
  );
}

export type Tone = 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'gray';
export function Badge({ children, tone = 'gray' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`badge ${tone === 'gray' ? '' : tone}`}>{children}</span>;
}

export function Empty({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon ?? <Inbox size={20} />}</div>
      <h3>{title}</h3>
      {children && <div className="sub" style={{ marginBottom: 10 }}>{children}</div>}
      {action}
    </div>
  );
}

export function Avatar({ name, src, size }: { name: string; src?: string | null; size?: 'lg' }) {
  return <span className={`avatar ${size ?? ''}`}>{src ? <img src={src} alt="" /> : initials(name)}</span>;
}

export function Field({ label, htmlFor, required, hint, error, children, full }: { label: string; htmlFor?: string; required?: boolean; hint?: ReactNode; error?: string; children: ReactNode; full?: boolean }) {
  return (
    <div className={`field ${full ? 'full' : ''}`}>
      <label htmlFor={htmlFor} className={required ? 'req' : ''}>{label}</label>
      {children}
      {hint && !error && <div className="hint">{hint}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export function Tabs({ items, active }: { items: { href: string; label: ReactNode; key: string }[]; active: string }) {
  return (
    <nav className="tabs">
      {items.map((i) => <Link key={i.key} href={i.href} className={i.key === active ? 'active' : ''}>{i.label}</Link>)}
    </nav>
  );
}

export function Stars({ value }: { value: number }) {
  const v = Math.round(value);
  return <span className="stars" aria-label={`${value} / 5`}>{'★'.repeat(v)}{'☆'.repeat(Math.max(0, 5 - v))}</span>;
}

export function Forbidden({ message = 'このページを表示する権限がありません。' }: { message?: string }) {
  return (
    <div className="card"><Empty title="アクセスできません">{message}</Empty></div>
  );
}

export function Bar({ value, max }: { value: number; max: number }) {
  const w = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return <div className="bar"><span style={{ width: `${w}%` }} /></div>;
}
