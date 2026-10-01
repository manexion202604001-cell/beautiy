import type { ReactNode } from 'react';
import { Link } from 'react-router';

/** Split-screen frame for login / signup / invite */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grid min-h-screen bg-bg lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-[#0d3b37] p-12 text-white lg:flex lg:flex-col">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-[#14b8a6]/25 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -left-20 h-[28rem] w-[28rem] rounded-full bg-[#f59e0b]/15 blur-3xl"
        />
        <Link to="/" className="relative flex items-center gap-2.5 text-white">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M7 16c0-2.4 1.8-3.4 5-3.4s5-1.3 5-3.5C17 7.2 15 6 12.4 6 10.3 6 8.7 6.8 7.9 8.1" />
              <circle cx="16.5" cy="17" r="1.6" fill="currentColor" stroke="none" />
            </svg>
          </span>
          <span className="text-lg font-semibold tracking-tight">Salon OS</span>
        </Link>
        <div className="relative mt-auto max-w-md">
          <p className="text-3xl font-semibold leading-snug tracking-tight">
            予約から再来店まで、
            <br />
            サロンの毎日をひとつの画面に。
          </p>
          <p className="mt-4 text-[15px] leading-relaxed text-white/70">
            カレンダー・顧客管理・メニュー・シフトを一元化。お客様はLINEやWebからアプリ不要で予約できます。
          </p>
          <ul className="mt-8 grid grid-cols-2 gap-3 text-[13px] text-white/80">
            {[
              'スタッフ別カレンダー',
              '重複顧客の名寄せ',
              '指名・フリー予約',
              '多店舗の切り替え',
            ].map((t) => (
              <li key={t} className="flex items-center gap-2 rounded-lg bg-white/[0.07] px-3 py-2">
                <span className="h-1.5 w-1.5 rounded-full bg-[#5eead4]" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-[400px]">
          <div className="mb-8 lg:hidden">
            <span className="text-lg font-semibold tracking-tight text-fg">Salon OS</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
          {subtitle ? <p className="mt-1.5 text-[13px] text-muted">{subtitle}</p> : null}
          <div className="mt-7">{children}</div>
          {footer ? <div className="mt-8 text-center text-[13px] text-muted">{footer}</div> : null}
        </div>
      </main>
    </div>
  );
}
