import Link from 'next/link';
import { addDays, isDateStr, maskEmail, maskPhone, normalizePhone, startOfWeek, todayIn } from '@salonos/core';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { bookableStaff } from '@/lib/server/booking';
import { couponLabel, couponValidAt, loadLedger, pendingRequests } from '@/lib/server/reservations';
import { maskedContact } from '@/lib/server/pii';
import { PageHeader, Tabs } from '@/components/ui';
import { Ledger } from './Ledger';
import { WaitlistSection } from './WaitlistSection';
import type { CreatePreset } from './types';

export const metadata = { title: '予約台帳' };

type SP = Record<string, string | string[] | undefined>;

export default async function ReservationsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePage('appointment.read');
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);
  const shop = ctx.shop;
  const today = todayIn(shop.timezone);
  const tab = str('tab') === 'waitlist' ? 'waitlist' : 'ledger';
  const date = isDateStr(str('date') ?? '') ? str('date')! : today;
  const view = str('view') === 'week' ? 'week' : 'day';

  const waitCount = await prisma.waitlistEntry.count({ where: { shopId: shop.id, status: { in: ['WAITING', 'CONTACTED'] } } });
  const tabs = (
    <Tabs
      active={tab}
      items={[
        { key: 'ledger', label: '予約台帳', href: `/reservations?view=${view}&date=${date}` },
        { key: 'waitlist', label: <>キャンセル待ち{waitCount > 0 && <span className="badge amber" style={{ marginLeft: 6 }}>{waitCount}</span>}</>, href: `/reservations?tab=waitlist&date=${date}` },
      ]}
    />
  );

  if (tab === 'waitlist') {
    return (
      <>
        <PageHeader title="予約台帳" sub={shop.name} />
        {tabs}
        <WaitlistSection ctx={ctx} status={str('status')} />
      </>
    );
  }

  const from = view === 'week' ? startOfWeek(date) : date;
  const days = view === 'week' ? 7 : 1;
  const now = new Date();
  const [ledger, menus, coupons, assigned, bookable, pending] = await Promise.all([
    loadLedger(ctx.org.id, shop, from, days),
    prisma.menu.findMany({ where: { shopId: shop.id, organizationId: ctx.org.id, active: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    prisma.coupon.findMany({ where: { shopId: shop.id, organizationId: ctx.org.id, active: true }, orderBy: { createdAt: 'asc' } }),
    prisma.membership.findMany({ where: { organizationId: ctx.org.id, active: true, shops: { some: { shopId: shop.id } } }, orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }] }),
    bookableStaff(shop.id),
    pendingRequests(ctx.org.id, shop.id, shop.timezone, now),
  ]);
  const bookableIds = new Set(bookable.map((b) => b.userId));

  // Prefill from a waitlist entry ("予約に変換") or open a specific appointment (?appt=).
  let preset: CreatePreset | undefined;
  const waitId = str('waitlist');
  if (waitId && ctx.can('appointment.write')) {
    const w = await prisma.waitlistEntry.findFirst({ where: { id: waitId, shopId: shop.id } });
    if (w) {
      const c = w.customerId && ctx.can('customer.read') ? await prisma.customer.findFirst({ where: { id: w.customerId, organizationId: ctx.org.id, deletedAt: null } }) : null;
      const phone = normalizePhone(w.contact);
      preset = {
        date: w.desiredDate >= today ? w.desiredDate : today, startMin: 600,
        staffMode: w.staffId ? 'staff' : 'auto', staffId: w.staffId,
        customer: c ? { id: c.id, name: `${c.lastName} ${c.firstName}`.trim(), kana: `${c.lastNameKana ?? ''} ${c.firstNameKana ?? ''}`.trim(), phone: maskedContact(c).phone, visitCount: c.visitCount, lastVisitAt: c.lastVisitAt?.toISOString() ?? null } : null,
        newName: !c ? w.name : undefined,
        newPhone: !c && phone && ctx.piiByDefault ? phone : undefined,
        note: [w.menuNote && `希望メニュー：${w.menuNote}`, w.timeNote && `希望時間：${w.timeNote}`, w.contact && !ctx.piiByDefault && `連絡先：${maskContact(w.contact)}`].filter(Boolean).join('\n'),
        waitlistId: w.id,
      };
    }
  }

  return (
    <>
      <PageHeader
        title="予約台帳"
        sub={<>{shop.name}・席数 {shop.seatCount}・<Link className="link" href={`/book/${shop.slug}`} target="_blank">ネット予約ページ</Link></>}
      />
      {tabs}
      <Ledger
        key={`${view}-${from}-${shop.id}`}
        shop={{ id: shop.id, name: shop.name, timezone: shop.timezone, slotIntervalMin: shop.slotIntervalMin, seatCount: shop.seatCount, slug: shop.slug }}
        view={view}
        date={date}
        from={from}
        today={today}
        prevDate={addDays(date, view === 'week' ? -7 : -1)}
        nextDate={addDays(date, view === 'week' ? 7 : 1)}
        days={ledger.days}
        columns={ledger.columns}
        appts={ledger.appts}
        foreign={ledger.foreign}
        staffOptions={assigned.map((m) => ({ userId: m.userId, name: m.displayName, bookable: bookableIds.has(m.userId) }))}
        menus={menus.map((m) => ({ id: m.id, category: m.category, name: m.name, price: m.price, durationMin: m.durationMin, isConsultation: m.isConsultation }))}
        coupons={coupons.filter((c) => couponValidAt(c, now)).map((c) => ({ id: c.id, name: c.name, discountType: c.discountType, discountValue: c.discountValue, menuIds: c.menuIds, label: couponLabel(c) }))}
        pending={pending}
        perms={{ write: ctx.can('appointment.write'), customerRead: ctx.can('customer.read'), customerWrite: ctx.can('customer.write') }}
        preset={preset}
        openId={str('appt')}
      />
    </>
  );
}

function maskContact(v: string) {
  if (v.includes('@')) return maskEmail(v);
  return maskPhone(normalizePhone(v) ?? v);
}
