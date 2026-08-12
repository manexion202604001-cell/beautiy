import { addDays, differenceInMinutes, format, isSameDay } from 'date-fns'
import { ja } from 'date-fns/locale'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button, Tag } from '../components/ui'
import { useStoreVersion } from '../hooks/useStore'
import { listByDate } from '../lib/api/reservations'
import { menus, salon, staffList } from '../lib/api/store'
import type { Reservation } from '../lib/domain/types'

const OPEN_HOUR = 10
const CLOSE_HOUR = 20
const HOUR_PX = 64

/** S-03 予約カレンダー（日 × スタッフ別ガントビュー） */
export function Calendar() {
  useStoreVersion()
  const [date, setDate] = useState(() => new Date())
  const navigate = useNavigate()
  const reservations = listByDate(date)
  const isToday = isSameDay(date, new Date())
  const hours = Array.from({ length: CLOSE_HOUR - OPEN_HOUR + 1 }, (_, i) => OPEN_HOUR + i)

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.22em] text-gold">Reservations</p>
          <h1 className="rule-gold mt-1 font-display text-[26px] tracking-wide">予約カレンダー</h1>
        </div>
        <Button onClick={() => navigate('/reservations/new')}>新規予約</Button>
      </header>

      <div className="mb-4 flex items-center gap-2">
        <button
          onClick={() => setDate((d) => addDays(d, -1))}
          className="rounded-md border border-line-strong px-3 py-1.5 text-[13px] hover:border-gold"
          aria-label="前日"
        >
          ←
        </button>
        <button
          onClick={() => setDate(new Date())}
          className={`rounded-md border px-3 py-1.5 text-[13px] ${isToday ? 'border-gold text-gold-deep' : 'border-line-strong hover:border-gold'}`}
        >
          今日
        </button>
        <button
          onClick={() => setDate((d) => addDays(d, 1))}
          className="rounded-md border border-line-strong px-3 py-1.5 text-[13px] hover:border-gold"
          aria-label="翌日"
        >
          →
        </button>
        <p className="ml-2 text-[15px] tracking-wide text-ink-soft">
          {format(date, 'yyyy年M月d日（E）', { locale: ja })}
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line bg-paper">
        <div className="min-w-[720px]">
          {/* Staff header */}
          <div className="grid border-b border-line" style={{ gridTemplateColumns: `56px repeat(${staffList.length}, 1fr)` }}>
            <div />
            {staffList.map((s) => (
              <div key={s.id} className="border-l border-line px-3 py-3">
                <p className="text-[13px]">{s.name}</p>
                <p className="text-[10px] uppercase tracking-[0.14em] text-stone">
                  {s.role === 'freelance' ? 'Freelance' : 'Staff'}
                </p>
              </div>
            ))}
          </div>
          {/* Grid body */}
          <div
            className="relative grid"
            style={{
              gridTemplateColumns: `56px repeat(${staffList.length}, 1fr)`,
              height: (CLOSE_HOUR - OPEN_HOUR) * HOUR_PX,
            }}
          >
            {/* time gutter */}
            <div className="relative">
              {hours.slice(0, -1).map((h) => (
                <div
                  key={h}
                  className="tnum absolute right-2 -translate-y-1/2 text-[11px] text-stone"
                  style={{ top: (h - OPEN_HOUR) * HOUR_PX }}
                >
                  {h}:00
                </div>
              ))}
            </div>
            {staffList.map((s) => (
              <div key={s.id} className="relative border-l border-line">
                {hours.slice(0, -1).map((h) => (
                  <div
                    key={h}
                    className="absolute inset-x-0 border-t border-line/70"
                    style={{ top: (h - OPEN_HOUR) * HOUR_PX }}
                  />
                ))}
                {reservations
                  .filter((r) => r.staffId === s.id)
                  .map((r) => (
                    <ReservationBlock key={r.id} reservation={r} color={s.color} />
                  ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="mt-3 text-[11px] text-stone">
        営業時間 {salon.openTime}–{salon.closeTime} ／ ダブルブッキングはDB層の排他制約（EXCLUDE USING gist）で防止されます
      </p>
    </div>
  )
}

function ReservationBlock({ reservation: r, color }: { reservation: Reservation; color: string }) {
  const start = new Date(r.start)
  const end = new Date(r.end)
  const top = ((start.getHours() - OPEN_HOUR) * 60 + start.getMinutes()) * (HOUR_PX / 60)
  const height = Math.max(30, differenceInMinutes(end, start) * (HOUR_PX / 60) - 2)
  const cancelled = r.status === 'cancelled' || r.status === 'no_show'
  const names = r.menuIds.map((id) => menus.find((m) => m.id === id)?.name).filter(Boolean).join('・')

  return (
    <Link
      to={`/reservations/${r.id}`}
      className={`absolute inset-x-1 overflow-hidden rounded-md border bg-paper-warm px-2 py-1.5 transition-shadow hover:shadow-md ${
        cancelled ? 'opacity-40' : ''
      }`}
      style={{ top, height, borderColor: color, borderLeftWidth: 3 }}
    >
      <p className="tnum text-[10px] text-stone">
        {format(start, 'HH:mm')}–{format(end, 'HH:mm')}
      </p>
      <p className="truncate text-[12px] leading-tight">{r.customerName}</p>
      <p className="truncate text-[10px] text-stone">{names}</p>
      {r.status === 'tentative' ? (
        <div className="mt-0.5">
          <Tag tone="amber">仮</Tag>
        </div>
      ) : null}
    </Link>
  )
}
