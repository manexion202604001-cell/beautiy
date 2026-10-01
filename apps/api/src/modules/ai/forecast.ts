import { assertShopAccess, requireAnyPermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { dayBounds, localDate, weekdayOf } from '../../lib/time.js';
import { addDaysIso } from '../analytics/scope.js';
import type { ForecastQuery } from './schemas.js';

export const FORECAST_WEEKS = 8;
export const FORECAST_METHOD =
  '曜日別移動平均: 予測日と同じ曜日の直近8週(本日より前)の日次純売上(analytics_daily_shop)の平均をベースラインとし、' +
  '既に入っている未来予約の見積額(estimated_total)を下限として予測値 = max(ベースライン, 予約済み見積額)。' +
  '信頼帯は同じ8週の標準偏差(σ)で 予測値 ± 1σ(下限は予約済み見積額)。集計が無い日は売上0として扱う。';

const FORECAST_APPT_STATUSES = ['tentative', 'confirmed', 'checked_in', 'in_service'] as const;

/** GET /ai/forecast — per-day sales forecast for the next N days (starting tomorrow, shop TZ). */
export async function salesForecast(ctx: Ctx, input: ForecastQuery, now = new Date()) {
  requireAnyPermission(ctx.actor, 'analytics.read', 'sales.read');
  assertShopAccess(ctx.actor, input.shopId);
  const shop = await ctx.trx.selectFrom('shops').select(['id', 'name', 'timezone']).where('id', '=', input.shopId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!shop) throw Errors.notFound('店舗', input.shopId);
  const tz = shop.timezone;
  const today = localDate(now, tz);
  const historyFrom = addDaysIso(today, -7 * FORECAST_WEEKS);
  const historyTo = addDaysIso(today, -1);

  const history = await ctx.trx
    .selectFrom('analytics_daily_shop')
    .select(['date', 'sales_total'])
    .where('shop_id', '=', shop.id)
    .where('date', '>=', historyFrom)
    .where('date', '<=', historyTo)
    .execute();
  const salesByDate = new Map(history.map((h) => [h.date, h.sales_total]));

  // the 8 most recent dates before today for each weekday
  const byWeekday = new Map<number, string[]>();
  for (let k = 1; k <= 7 * FORECAST_WEEKS; k++) {
    const d = addDaysIso(today, -k);
    const w = weekdayOf(d, tz);
    byWeekday.set(w, [...(byWeekday.get(w) ?? []), d]);
  }

  const firstDay = addDaysIso(today, 1);
  const lastDay = addDaysIso(today, input.days);
  const appts = await ctx.trx
    .selectFrom('appointments')
    .select(['start_at', 'estimated_total'])
    .where('shop_id', '=', shop.id)
    .where('deleted_at', 'is', null)
    .where('status', 'in', [...FORECAST_APPT_STATUSES])
    .where('start_at', '>=', dayBounds(firstDay, tz).start)
    .where('start_at', '<', dayBounds(lastDay, tz).end)
    .execute();
  const bookedByDate = new Map<string, { amount: number; count: number }>();
  for (const a of appts) {
    const d = localDate(a.start_at, tz);
    const cur = bookedByDate.get(d) ?? { amount: 0, count: 0 };
    cur.amount += a.estimated_total;
    cur.count += 1;
    bookedByDate.set(d, cur);
  }

  const days = [];
  for (let i = 1; i <= input.days; i++) {
    const date = addDaysIso(today, i);
    const weekday = weekdayOf(date, tz);
    const sample = (byWeekday.get(weekday) ?? []).map((d) => salesByDate.get(d) ?? 0);
    const mean = sample.length ? sample.reduce((a, b) => a + b, 0) / sample.length : 0;
    const sigma = sample.length ? Math.sqrt(sample.reduce((a, b) => a + (b - mean) ** 2, 0) / sample.length) : 0;
    const booked = bookedByDate.get(date) ?? { amount: 0, count: 0 };
    const baseline = Math.round(mean);
    const forecast = Math.max(baseline, booked.amount);
    days.push({
      date,
      weekday,
      baseline,
      sigma: Math.round(sigma),
      bookedAmount: booked.amount,
      bookedAppointments: booked.count,
      forecast,
      lower: Math.max(booked.amount, Math.round(forecast - sigma)),
      upper: Math.round(forecast + sigma),
      sampleDays: sample.length,
    });
  }
  const total = days.reduce((acc, d) => ({ forecast: acc.forecast + d.forecast, lower: acc.lower + d.lower, upper: acc.upper + d.upper, booked: acc.booked + d.bookedAmount }), {
    forecast: 0,
    lower: 0,
    upper: 0,
    booked: 0,
  });
  await audit(ctx, { action: 'sales.view', resourceType: 'analytics', shopId: shop.id, metadata: { report: 'ai.forecast', days: input.days } });
  return {
    shopId: shop.id,
    shopName: shop.name,
    generatedAt: now.toISOString(),
    today,
    method: FORECAST_METHOD,
    history: { from: historyFrom, to: historyTo, weeks: FORECAST_WEEKS, daysWithData: history.length },
    days,
    total,
  };
}
