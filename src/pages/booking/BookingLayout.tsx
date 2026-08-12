import type { ReactNode } from 'react'
import { salon } from '../../lib/api/store'

/** 顧客向けページ共通レイアウト（C-01〜C-03） */
export function BookingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-porcelain">
      <header className="bg-night px-6 py-8 text-center text-paper-warm">
        <p className="font-display text-[26px] tracking-[0.32em]">BEAUTIY</p>
        <p className="mt-1.5 text-[10px] uppercase tracking-[0.26em] text-gold">{salon.name}</p>
      </header>
      <main className="mx-auto w-full max-w-lg px-5 py-8">{children}</main>
      <footer className="pb-10 text-center text-[10px] uppercase tracking-[0.2em] text-stone">
        © MAISON BEAUTIY
      </footer>
    </div>
  )
}
