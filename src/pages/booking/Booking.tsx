import { addDays, addMinutes, format, isSameDay } from 'date-fns'
import { ja } from 'date-fns/locale'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, Field, Input, yen } from '../../components/ui'
import { availableSlots } from '../../lib/booking/slots'
import { createReservation, listReservations } from '../../lib/api/reservations'
import { menus, salon, staffList } from '../../lib/api/store'
import { BookingLayout } from './BookingLayout'

type Step = 'menu' | 'slot' | 'info' | 'done'

/** C-01 顧客向けWeb予約（メニュー → 空き枠 → お客様情報 → 完了） */
export function Booking() {
  const [step, setStep] = useState<Step>('menu')
  const [menuId, setMenuId] = useState('')
  const [staffId, setStaffId] = useState('')
  const [slot, setSlot] = useState<Date | null>(null)
  const [dayOffset, setDayOffset] = useState(1)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [confirmed, setConfirmed] = useState<{ start: Date; menu: string; staff: string } | null>(null)

  const menu = menus.find((m) => m.id === menuId)
  const date = useMemo(() => addDays(new Date(), dayOffset), [dayOffset])

  const slots = useMemo(() => {
    if (!menu || !staffId) return []
    const busy = listReservations()
      .filter(
        (r) =>
          r.staffId === staffId &&
          r.status !== 'cancelled' &&
          r.status !== 'no_show' &&
          isSameDay(new Date(r.start), date),
      )
      .map((r) => ({ start: new Date(r.start), end: new Date(r.end) }))
    return availableSlots(date, busy, {
      openTime: salon.openTime,
      closeTime: salon.closeTime,
      durationMin: menu.durationMin,
    })
  }, [menu, staffId, date])

  const book = () => {
    if (!menu || !slot || !staffId) return
    createReservation({
      customerId: null,
      customerName: `${name} 様`,
      staffId,
      menuIds: [menu.id],
      start: slot.toISOString(),
      end: addMinutes(slot, menu.durationMin).toISOString(),
      nominated: true,
      status: 'confirmed',
      source: 'web',
      note: `Web予約 / ${phone}`,
    })
    setConfirmed({
      start: slot,
      menu: menu.name,
      staff: staffList.find((s) => s.id === staffId)?.name ?? '',
    })
    setStep('done')
  }

  return (
    <BookingLayout>
      <StepIndicator current={step} />

      {step === 'menu' ? (
        <div className="space-y-3">
          <h2 className="font-display text-[20px] tracking-wide">メニューをお選びください</h2>
          {menus.map((m) => (
            <button
              key={m.id}
              onClick={() => setMenuId(m.id)}
              className={`flex w-full items-center justify-between rounded-lg border bg-paper px-5 py-4 text-left transition-colors ${
                menuId === m.id ? 'border-gold shadow-sm' : 'border-line hover:border-gold/60'
              }`}
            >
              <span>
                <span className="block text-[14px]">{m.name}</span>
                <span className="mt-0.5 block text-[12px] text-stone">
                  {m.category} ・ {m.durationMin}分
                </span>
              </span>
              <span className="tnum text-[14px] text-gold-deep">{yen(m.price)}</span>
            </button>
          ))}
          <div className="pt-2">
            <p className="mb-2 text-[11px] uppercase tracking-[0.18em] text-stone">スタイリスト</p>
            <div className="flex flex-wrap gap-2">
              {staffList.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setStaffId(s.id)}
                  className={`rounded-md border px-4 py-2.5 text-[13px] transition-colors ${
                    staffId === s.id ? 'border-gold bg-gold-tint text-gold-deep' : 'border-line-strong bg-paper hover:border-gold/60'
                  }`}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>
          <Button className="mt-4 w-full" disabled={!menuId || !staffId} onClick={() => setStep('slot')}>
            日時の選択へ
          </Button>
        </div>
      ) : null}

      {step === 'slot' ? (
        <div>
          <h2 className="mb-4 font-display text-[20px] tracking-wide">ご希望の日時</h2>
          <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
            {Array.from({ length: 14 }, (_, i) => i + 1).map((off) => {
              const d = addDays(new Date(), off)
              return (
                <button
                  key={off}
                  onClick={() => {
                    setDayOffset(off)
                    setSlot(null)
                  }}
                  className={`shrink-0 rounded-md border px-3.5 py-2.5 text-center transition-colors ${
                    off === dayOffset ? 'border-gold bg-gold-tint' : 'border-line bg-paper hover:border-gold/60'
                  }`}
                >
                  <span className="block text-[11px] text-stone">{format(d, 'E', { locale: ja })}</span>
                  <span className="tnum block text-[14px]">{format(d, 'M/d')}</span>
                </button>
              )
            })}
          </div>
          {slots.length === 0 ? (
            <Card className="p-6 text-center text-[13px] text-stone">
              この日は空きがありません。別の日をお選びください。
            </Card>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {slots.map((s) => (
                <button
                  key={s.toISOString()}
                  onClick={() => setSlot(s)}
                  className={`tnum rounded-md border py-2.5 text-[13px] transition-colors ${
                    slot && s.getTime() === slot.getTime()
                      ? 'border-gold bg-gold-tint text-gold-deep'
                      : 'border-line bg-paper hover:border-gold/60'
                  }`}
                >
                  {format(s, 'HH:mm')}
                </button>
              ))}
            </div>
          )}
          <div className="mt-5 flex gap-3">
            <Button variant="ghost" onClick={() => setStep('menu')}>
              戻る
            </Button>
            <Button className="flex-1" disabled={!slot} onClick={() => setStep('info')}>
              お客様情報へ
            </Button>
          </div>
        </div>
      ) : null}

      {step === 'info' ? (
        <div className="space-y-4">
          <h2 className="font-display text-[20px] tracking-wide">お客様情報</h2>
          <Card className="space-y-4 p-5">
            <Field label="お名前">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="山田 花子" />
            </Field>
            <Field label="お電話番号">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="090-0000-0000" inputMode="tel" />
            </Field>
          </Card>
          <Card className="p-5 text-[13px] leading-relaxed text-ink-soft">
            <p className="mb-1 text-[11px] uppercase tracking-[0.18em] text-stone">ご予約内容</p>
            {menu?.name} ／ {staffList.find((s) => s.id === staffId)?.name}
            <br />
            {slot ? format(slot, 'yyyy年M月d日（E） HH:mm〜', { locale: ja }) : ''}
            <span className="tnum">（{menu?.durationMin}分・{menu ? yen(menu.price) : ''}）</span>
          </Card>
          <div className="flex gap-3">
            <Button variant="ghost" onClick={() => setStep('slot')}>
              戻る
            </Button>
            <Button className="flex-1" disabled={!name.trim() || !phone.trim()} onClick={book}>
              この内容で予約する
            </Button>
          </div>
        </div>
      ) : null}

      {step === 'done' && confirmed ? (
        <Card className="p-8 text-center">
          <p className="font-display text-[22px] tracking-wide">ご予約ありがとうございます</p>
          <div className="mx-auto mt-4 h-px w-10 bg-gold" />
          <p className="mt-5 text-[14px] leading-loose text-ink-soft">
            {format(confirmed.start, 'yyyy年M月d日（E） HH:mm', { locale: ja })}
            <br />
            {confirmed.menu} ／ {confirmed.staff}
          </p>
          <p className="mt-4 text-[12px] leading-relaxed text-stone">
            確認メッセージをLINEにお送りしました。
            <br />
            ご来店前に
            <Link to="/booking/counseling" className="mx-1 text-gold-deep underline">
              カウンセリングシート
            </Link>
            のご記入にご協力ください。
          </p>
          <Link to="/booking/manage" className="mt-6 inline-block text-[12px] tracking-wide text-gold-deep hover:underline">
            予約の確認・変更はこちら →
          </Link>
        </Card>
      ) : null}
    </BookingLayout>
  )
}

function StepIndicator({ current }: { current: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: 'menu', label: 'メニュー' },
    { key: 'slot', label: '日時' },
    { key: 'info', label: 'お客様情報' },
    { key: 'done', label: '完了' },
  ]
  const idx = steps.findIndex((s) => s.key === current)
  return (
    <ol className="mb-7 flex items-center justify-center gap-2">
      {steps.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2">
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-full border text-[11px] ${
              i <= idx ? 'border-gold bg-gold text-paper' : 'border-line-strong text-stone'
            }`}
          >
            {i + 1}
          </span>
          <span className={`text-[11px] tracking-wide ${i <= idx ? 'text-ink' : 'text-stone'}`}>{s.label}</span>
          {i < steps.length - 1 ? <span className="mx-1 h-px w-5 bg-line-strong" /> : null}
        </li>
      ))}
    </ol>
  )
}
