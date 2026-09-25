// Public slot availability for the customer booking flow. Returns start times only — no PII.
import { NextResponse, type NextRequest } from 'next/server';
import { isDateStr, minutesToHHMM, toLocalParts } from '@salonos/core';
import { prisma } from '@/lib/server/db';
import { getAvailability } from '@/lib/server/booking';
import { availableSlots, bookingDuration, customerCanModify, loadManagedAppointment, rateLimit, resolveMenus } from '@/lib/server/reservations';

export const dynamic = 'force-dynamic';

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(req: NextRequest) {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
  if (!rateLimit(`avail:${ip}`, 240, 60_000)) return bad('アクセスが集中しています。しばらくしてから再度お試しください。', 429);
  const q = req.nextUrl.searchParams;
  const slug = (q.get('shop') ?? '').slice(0, 80);
  const date = q.get('date') ?? '';
  if (!slug || !isDateStr(date)) return bad('パラメータが正しくありません');
  const shop = await prisma.shop.findUnique({ where: { slug }, select: { id: true, organizationId: true, timezone: true, active: true } });
  if (!shop || !shop.active) return bad('店舗が見つかりません', 404);

  try {
    const hold = (q.get('hold') ?? '').slice(0, 80) || undefined;
    const apptToken = q.get('appt');
    let slots;
    let durationMin: number;
    if (apptToken) {
      // customer reschedule: same duration & nominated stylist, ignoring the appointment itself
      const a = await loadManagedAppointment(apptToken);
      if (!a || a.shopId !== shop.id) return bad('ご予約が見つかりません', 404);
      if (!customerCanModify(a, a.shop).ok) return NextResponse.json({ date, durationMin: 0, slots: [] }, { headers: { 'Cache-Control': 'no-store' } });
      durationMin = Math.round((a.endAt.getTime() - a.startAt.getTime()) / 60000);
      slots = await availableSlots({ shopId: shop.id, date, durationMin, staffId: a.nominated ? a.staffId : null, excludeAppointmentId: a.id });
    } else {
      const menuIds = (q.get('menus') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
      if (!menuIds.length) return bad('メニューを選択してください');
      const menus = await resolveMenus(shop.organizationId, shop.id, menuIds, { publicOnly: true });
      durationMin = bookingDuration(menus.durationMin);
      const staffId = (q.get('staff') ?? '').slice(0, 64) || null;
      if (staffId) {
        const ok = await prisma.staffAssignment.findFirst({ where: { shopId: shop.id, membership: { userId: staffId, active: true, bookable: true } } });
        if (!ok) return bad('選択されたスタッフは現在ネット予約を受け付けていません');
      }
      slots = await getAvailability({ shopId: shop.id, date, durationMin, staffId, excludeHoldToken: hold });
    }
    return NextResponse.json(
      { date, durationMin, slots: slots.map((s) => ({ start: new Date(s.start).toISOString(), time: minutesToHHMM(toLocalParts(new Date(s.start), shop.timezone).minutes) })) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    if (e?.status && e.status < 500) return bad(e.message, e.status);
    console.error('[availability]', e);
    return bad('空き状況の取得に失敗しました', 500);
  }
}
