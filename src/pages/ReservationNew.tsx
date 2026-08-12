import { addMinutes, format } from 'date-fns'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Field, Input, PageHeader, Select, Textarea, yen } from '../components/ui'
import { searchCustomers } from '../lib/api/customers'
import { createReservation, DoubleBookingError } from '../lib/api/reservations'
import { menus, staffList } from '../lib/api/store'

/** S-04 予約登録 */
export function ReservationNew() {
  const navigate = useNavigate()
  const [customerId, setCustomerId] = useState('')
  const [walkInName, setWalkInName] = useState('')
  const [staffId, setStaffId] = useState(staffList[0].id)
  const [menuIds, setMenuIds] = useState<string[]>([])
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [time, setTime] = useState('10:00')
  const [nominated, setNominated] = useState(true)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const customerList = searchCustomers({})
  const selected = menus.filter((m) => menuIds.includes(m.id))
  const duration = selected.reduce((s, m) => s + m.durationMin, 0)
  const total = selected.reduce((s, m) => s + m.price, 0)

  const start = useMemo(() => new Date(`${date}T${time}:00`), [date, time])
  const end = useMemo(() => addMinutes(start, Math.max(duration, 30)), [start, duration])

  const toggleMenu = (id: string) =>
    setMenuIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const submit = () => {
    setError('')
    const customer = customerList.find((c) => c.id === customerId)
    const name = customer ? customer.name : walkInName.trim()
    if (!name) {
      setError('顧客を選択するか、氏名を入力してください')
      return
    }
    if (menuIds.length === 0) {
      setError('メニューを1つ以上選択してください')
      return
    }
    try {
      const created = createReservation({
        customerId: customer?.id ?? null,
        customerName: customer ? customer.name : `新規：${name} 様`,
        staffId,
        menuIds,
        start: start.toISOString(),
        end: end.toISOString(),
        nominated,
        status: 'confirmed',
        source: 'app',
        note,
      })
      navigate(`/reservations/${created.id}`)
    } catch (e) {
      if (e instanceof DoubleBookingError) {
        setError(
          `${format(new Date(e.conflict.start), 'HH:mm')}〜 に「${e.conflict.customerName}」の予約が既に存在します。時間または担当を変更してください。`,
        )
      } else {
        throw e
      }
    }
  }

  return (
    <div className="max-w-2xl">
      <PageHeader eyebrow="Reservations" title="新規予約" />
      <Card className="space-y-5 p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="顧客">
            <Select value={customerId} onChange={setCustomerId}>
              <option value="">— 新規のお客様 —</option>
              {customerList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}（{c.nameKana}）
                </option>
              ))}
            </Select>
          </Field>
          {customerId === '' ? (
            <Field label="氏名（新規）">
              <Input value={walkInName} onChange={(e) => setWalkInName(e.target.value)} placeholder="例：宇佐美" />
            </Field>
          ) : (
            <div />
          )}
          <Field label="担当スタッフ">
            <Select value={staffId} onChange={setStaffId}>
              {staffList.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="指名区分">
            <Select value={nominated ? '1' : '0'} onChange={(v) => setNominated(v === '1')}>
              <option value="1">指名</option>
              <option value="0">フリー</option>
            </Select>
          </Field>
          <Field label="日付">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="開始時刻">
            <Input type="time" value={time} step={1800} onChange={(e) => setTime(e.target.value)} />
          </Field>
        </div>

        <div>
          <p className="mb-2 text-[11px] uppercase tracking-[0.18em] text-stone">メニュー</p>
          <div className="flex flex-wrap gap-2">
            {menus.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => toggleMenu(m.id)}
                className={`rounded-md border px-3 py-2 text-[13px] transition-colors ${
                  menuIds.includes(m.id)
                    ? 'border-gold bg-gold-tint text-gold-deep'
                    : 'border-line-strong text-ink-soft hover:border-gold'
                }`}
              >
                {m.name}
                <span className="tnum ml-1.5 text-[11px] text-stone">{m.durationMin}分</span>
              </button>
            ))}
          </div>
        </div>

        <Field label="申し送りメモ">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="アレルギー・ご要望など" />
        </Field>

        {selected.length > 0 ? (
          <div className="rounded-md bg-paper-warm px-4 py-3 text-[13px] text-ink-soft">
            所要 <span className="tnum">{duration}</span> 分（{format(start, 'HH:mm')}〜{format(end, 'HH:mm')}）
            ／ 合計 <span className="tnum">{yen(total)}</span>
          </div>
        ) : null}

        {error ? <p className="rounded-md bg-clay-tint px-4 py-3 text-[13px] text-clay">{error}</p> : null}

        <div className="flex gap-3">
          <Button onClick={submit}>予約を確定する</Button>
          <Button variant="ghost" onClick={() => navigate(-1)}>
            戻る
          </Button>
        </div>
      </Card>
    </div>
  )
}
