/**
 * Web予約の空き枠計算 (F-02-04)。
 * 純関数として実装し、Vitest で受け入れ基準を検証する。
 */
import { addMinutes, areIntervalsOverlapping, setHours, setMinutes, startOfDay } from 'date-fns'

export interface BusyInterval {
  start: Date
  end: Date
}

export interface SlotOptions {
  /** 営業開始 "10:00" */
  openTime: string
  /** 営業終了 "20:00" */
  closeTime: string
  /** 施術所要時間（分） */
  durationMin: number
  /** 枠の刻み（分） */
  stepMin?: number
}

function parseTime(base: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number)
  return setMinutes(setHours(startOfDay(base), h), m)
}

/** 指定日の予約可能な開始時刻一覧を返す */
export function availableSlots(date: Date, busy: BusyInterval[], opts: SlotOptions): Date[] {
  const step = opts.stepMin ?? 30
  const open = parseTime(date, opts.openTime)
  const close = parseTime(date, opts.closeTime)
  const slots: Date[] = []
  for (let t = open; addMinutes(t, opts.durationMin) <= close; t = addMinutes(t, step)) {
    const candidate = { start: t, end: addMinutes(t, opts.durationMin) }
    const conflict = busy.some((b) =>
      areIntervalsOverlapping(candidate, b),
    )
    if (!conflict) slots.push(t)
  }
  return slots
}
