import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'

export function PageHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: ReactNode }) {
  return (
    <header className="mb-6 flex items-end justify-between gap-4">
      <div>
        <p className="text-[11px] uppercase tracking-[0.22em] text-gold">{eyebrow}</p>
        <h1 className="rule-gold mt-1 font-display text-[26px] leading-tight tracking-wide text-ink">{title}</h1>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-paper shadow-[0_1px_2px_rgba(27,25,22,0.04)] ${className}`}>
      {children}
    </section>
  )
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-3 text-[11px] font-medium uppercase tracking-[0.2em] text-stone">{children}</h2>
  )
}

type Tone = 'neutral' | 'gold' | 'sage' | 'clay' | 'amber'

const toneClass: Record<Tone, string> = {
  neutral: 'bg-porcelain text-ink-soft border-line',
  gold: 'bg-gold-tint text-gold-deep border-gold/30',
  sage: 'bg-sage-tint text-sage border-sage/25',
  clay: 'bg-clay-tint text-clay border-clay/25',
  amber: 'bg-amber-tint text-amber border-amber/25',
}

export function Tag({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[11px] tracking-wide ${toneClass[tone]}`}>
      {children}
    </span>
  )
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger'
}

export function Button({ variant = 'primary', className = '', ...rest }: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-[13px] tracking-[0.08em] transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
  const styles = {
    primary: 'bg-night text-paper-warm hover:bg-night-soft',
    ghost: 'border border-line-strong bg-transparent text-ink hover:border-gold hover:text-gold-deep',
    danger: 'border border-clay/40 bg-transparent text-clay hover:bg-clay-tint',
  }[variant]
  return <button className={`${base} ${styles} ${className}`} {...rest} />
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] uppercase tracking-[0.18em] text-stone">{label}</span>
      {children}
    </label>
  )
}

const inputClass =
  'w-full rounded-md border border-line-strong bg-paper px-3 py-2.5 text-[14px] text-ink placeholder:text-stone/60 focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold/40'

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ''}`} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputClass} ${props.className ?? ''}`} />
}

export function Select({
  value,
  onChange,
  children,
  className = '',
}: {
  value: string
  onChange: (v: string) => void
  children: ReactNode
  className?: string
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${inputClass} ${className}`}>
      {children}
    </select>
  )
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-paper p-4">
      <p className="text-[11px] uppercase tracking-[0.18em] text-stone">{label}</p>
      <p className="tnum mt-2 font-display text-[26px] leading-none text-ink">{value}</p>
      {sub ? <p className="mt-1.5 text-[12px] text-stone">{sub}</p> : null}
    </div>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong px-6 py-10 text-center text-[13px] text-stone">
      {children}
    </div>
  )
}

export function yen(n: number): string {
  return `¥${n.toLocaleString('ja-JP')}`
}
