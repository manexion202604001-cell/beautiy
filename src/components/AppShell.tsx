import type { ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useSession } from '../hooks/useSession'

const nav = [
  { to: '/', label: 'ホーム', icon: IconHome },
  { to: '/calendar', label: '予約', icon: IconCalendar },
  { to: '/customers', label: '顧客', icon: IconPeople },
  { to: '/checkout', label: '会計', icon: IconReceipt },
  { to: '/register-close', label: 'レジ締め', icon: IconSafe },
  { to: '/messages', label: 'メッセージ', icon: IconChat },
  { to: '/reports', label: 'レポート', icon: IconChart },
  { to: '/settings', label: '設定', icon: IconGear },
]

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useSession()
  const navigate = useNavigate()

  return (
    <div className="min-h-dvh bg-porcelain md:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col bg-night text-paper-warm md:flex">
        <div className="px-6 pb-8 pt-8">
          <p className="font-display text-[22px] tracking-[0.3em]">BEAUTIY</p>
          <p className="mt-1 text-[10px] uppercase tracking-[0.24em] text-gold">Salon Management</p>
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-2.5 text-[13px] tracking-[0.08em] transition-colors ${
                  isActive ? 'bg-night-soft text-gold' : 'text-paper-warm/70 hover:text-paper-warm'
                }`
              }
            >
              <item.icon />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 px-6 py-5">
          <p className="text-[13px]">{user?.name}</p>
          <p className="mt-0.5 text-[11px] text-paper-warm/50">{user?.salonName}</p>
          <button
            onClick={() => {
              logout()
              navigate('/login')
            }}
            className="mt-3 text-[11px] uppercase tracking-[0.18em] text-gold/80 hover:text-gold"
          >
            ログアウト
          </button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 flex items-center justify-between bg-night px-5 py-3.5 text-paper-warm md:hidden">
        <p className="font-display text-[17px] tracking-[0.28em]">BEAUTIY</p>
        <p className="text-[11px] text-paper-warm/60">{user?.name}</p>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-5 pb-24 pt-6 md:px-10 md:pb-12 md:pt-10">
        {children}
      </main>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-20 flex justify-around border-t border-line bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {nav.slice(0, 5).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `flex flex-col items-center gap-1 px-3 py-2.5 text-[10px] tracking-wide ${
                isActive ? 'text-gold-deep' : 'text-stone'
              }`
            }
          >
            <item.icon />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

const ic = 'h-[18px] w-[18px] stroke-current'
const p = { fill: 'none', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

function IconHome() {
  return (
    <svg viewBox="0 0 24 24" className={ic} {...p}>
      <path d="M4 10.5 12 4l8 6.5V20h-5.5v-5h-5v5H4z" />
    </svg>
  )
}
function IconCalendar() {
  return (
    <svg viewBox="0 0 24 24" className={ic} {...p}>
      <rect x="4" y="6" width="16" height="14" rx="1" />
      <path d="M4 10h16M8 4v4M16 4v4" />
    </svg>
  )
}
function IconPeople() {
  return (
    <svg viewBox="0 0 24 24" className={ic} {...p}>
      <circle cx="9" cy="9" r="3.2" />
      <path d="M3.5 19c.8-3 2.9-4.5 5.5-4.5S13.7 16 14.5 19M15.5 6.5a3 3 0 1 1 0 5.6M16.5 14.6c2 .4 3.4 1.8 4 4.4" />
    </svg>
  )
}
function IconReceipt() {
  return (
    <svg viewBox="0 0 24 24" className={ic} {...p}>
      <path d="M6 3.5h12v17l-2.4-1.6-2.4 1.6-1.2-.8-1.2.8-2.4-1.6L6 20.5z" />
      <path d="M9 8.5h6M9 12h6" />
    </svg>
  )
}
function IconSafe() {
  return (
    <svg viewBox="0 0 24 24" className={ic} {...p}>
      <rect x="4" y="5" width="16" height="14" rx="1" />
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 8.8V7M12 17v-1.8M8.8 12H7M17 12h-1.8" />
    </svg>
  )
}
function IconChat() {
  return (
    <svg viewBox="0 0 24 24" className={ic} {...p}>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 4v-4h-1A2.5 2.5 0 0 1 4 13.5z" />
    </svg>
  )
}
function IconChart() {
  return (
    <svg viewBox="0 0 24 24" className={ic} {...p}>
      <path d="M5 20V10M12 20V4M19 20v-7" />
    </svg>
  )
}
function IconGear() {
  return (
    <svg viewBox="0 0 24 24" className={ic} {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 4v2.2M12 17.8V20M4 12h2.2M17.8 12H20M6.3 6.3l1.6 1.6M16.1 16.1l1.6 1.6M17.7 6.3l-1.6 1.6M7.9 16.1l-1.6 1.6" />
    </svg>
  )
}
