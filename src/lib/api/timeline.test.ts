import { addDays, format } from 'date-fns'
import { describe, expect, it } from 'vitest'
import { buildTimeline, ltvStats } from './timeline'

// モックストアのシードは「今日」基準の相対日付
const day = (offset: number) => format(addDays(new Date(), offset), 'yyyy-MM-dd')

describe('ltvStats', () => {
  it('実績カルテから平均来店周期と次回来店予測を算出する（§20, §32）', () => {
    // c-1: カルテが day(-57) と day(-12) → 周期45日、次回予測 = day(-12) + 45日
    const stats = ltvStats('c-1')
    expect(stats.averageIntervalDays).toBe(45)
    expect(stats.nextVisitPrediction).toBe(day(33))
    expect(stats.visitCount).toBeGreaterThanOrEqual(2)
    expect(stats.averageSpend).toBeGreaterThan(0)
  })

  it('実績が1回以下の場合は設定来店周期にフォールバックする', () => {
    // c-2: カルテ1件（day(-3)）、visitCycleDays=30
    const stats = ltvStats('c-2')
    expect(stats.averageIntervalDays).toBe(30)
    expect(stats.nextVisitPrediction).toBe(day(27))
  })
})

describe('buildTimeline', () => {
  it('予約・カルテ・会計・メッセージを統一時系列（降順）で返す（§88）', () => {
    const events = buildTimeline('c-1')
    const types = new Set(events.map((e) => e.type))
    expect(types.has('reservation')).toBe(true)
    expect(types.has('karte')).toBe(true)
    expect(types.has('payment')).toBe(true)
    expect(types.has('message')).toBe(true)
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1].at >= events[i].at).toBe(true)
    }
  })

  it('他の顧客のイベントを含まない', () => {
    const events = buildTimeline('c-5')
    expect(events.every((e) => !e.detail.includes('綾瀬'))).toBe(true)
  })
})
