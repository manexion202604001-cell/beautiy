'use server';
import { z } from 'zod';
import { hhmmToMinutes, isDateStr } from '@salonos/core';
import { prisma } from '@/lib/server/db';
import { requireStaff } from '@/lib/server/session';
import { audit } from '@/lib/server/audit';
import { AppError, runAction, type ActionResult } from '@/lib/server/errors';
import { bool } from '../_components/guard';

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const time = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim();
  if (!/^\d{1,2}:\d{2}$/.test(s)) return null;
  const m = hhmmToMinutes(s);
  return m >= 0 && m <= 24 * 60 ? m : null;
};

export async function saveHoursAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.shop');
    const rows: { weekday: number; openMin: number; closeMin: number; closed: boolean }[] = [];
    const fieldErrors: Record<string, string> = {};
    for (let wd = 0; wd < 7; wd++) {
      const closed = bool(fd, `closed_${wd}`);
      const open = time(fd.get(`open_${wd}`)), close = time(fd.get(`close_${wd}`));
      if (closed) { rows.push({ weekday: wd, openMin: open ?? 600, closeMin: close ?? 1200, closed: true }); continue; }
      if (open === null || close === null) { fieldErrors[`wd${wd}`] = `${WD[wd]}曜日の時刻を HH:MM で入力してください`; continue; }
      if (close <= open) { fieldErrors[`wd${wd}`] = `${WD[wd]}曜日は閉店時刻を開店時刻より後にしてください`; continue; }
      rows.push({ weekday: wd, openMin: open, closeMin: close, closed: false });
    }
    if (Object.keys(fieldErrors).length) return { ok: false, error: '営業時間を確認してください', fieldErrors };
    await prisma.$transaction(rows.map((r) => prisma.businessHour.upsert({
      where: { shopId_weekday: { shopId: ctx.shop.id, weekday: r.weekday } },
      create: { shopId: ctx.shop.id, ...r },
      update: { openMin: r.openMin, closeMin: r.closeMin, closed: r.closed },
    })));
    await audit(ctx, 'shop.hours_updated', 'Shop', ctx.shop.id, { hours: rows });
    return { ok: true, message: '営業時間を保存しました' };
  });
}

const holidaySchema = z.object({
  date: z.string().refine(isDateStr, '日付を選択してください'),
  endDate: z.string().optional().transform((v) => (v && isDateStr(v) ? v : null)),
  reason: z.string().trim().max(100).optional().transform((v) => v || null),
});

export async function addHolidayAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.shop');
    const { date, endDate, reason } = holidaySchema.parse(Object.fromEntries(fd));
    const dates: string[] = [];
    const end = endDate && endDate > date ? endDate : date;
    for (let d = date; d <= end; d = new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)) {
      dates.push(d);
      if (dates.length > 62) throw new AppError('一度に登録できるのは62日までです');
    }
    const r = await prisma.shopHoliday.createMany({ data: dates.map((d) => ({ shopId: ctx.shop.id, date: d, reason })), skipDuplicates: true });
    await audit(ctx, 'shop.holiday_added', 'Shop', ctx.shop.id, { dates, reason });
    return { ok: true, message: r.count ? `${r.count}日の休業日を登録しました` : 'すでに登録済みの日付です' };
  });
}

export async function removeHolidayAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.shop');
    const id = String(fd.get('id') ?? '');
    const h = await prisma.shopHoliday.findFirst({ where: { id, shopId: ctx.shop.id } });
    if (!h) throw new AppError('休業日が見つかりません');
    await prisma.shopHoliday.delete({ where: { id: h.id } });
    await audit(ctx, 'shop.holiday_removed', 'Shop', ctx.shop.id, { date: h.date });
  });
}
