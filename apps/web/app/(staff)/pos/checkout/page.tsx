import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { actorOf, appointmentLines, currentRegister, deriveManualDiscount, couponRule, providerModes } from '@/lib/server/pos';
import { pointsBalance } from '@/lib/server/customers';
import { Card, Empty, PageHeader } from '@/components/ui';
import { fmtDateTime, fmtRange } from '@/lib/format';
import type { DraftLine } from '@/lib/pos-shared';
import { CheckoutClient, type CheckoutInitial } from './CheckoutClient';

export const metadata = { title: '会計' };

type SP = { appointmentId?: string; customerId?: string; transactionId?: string };

function NotFoundCard({ message }: { message: string }) {
  return (
    <>
      <PageHeader title="会計" back={{ href: '/pos', label: 'POS' }} />
      <Card><Empty title="会計を開始できません" action={<Link className="btn secondary" href="/pos">POSに戻る</Link>}>{message}</Empty></Card>
    </>
  );
}

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePage('pos.checkout');
  const sp = await searchParams;
  const actor = actorOf(ctx);
  const cust = async (id: string | null) => {
    if (!id) return null;
    const c = await prisma.customer.findFirst({ where: { id, organizationId: ctx.org.id, mergedIntoId: null, deletedAt: null }, select: { id: true, lastName: true, firstName: true, lastNameKana: true, firstNameKana: true, visitCount: true } });
    if (!c) return null;
    return { id: c.id, name: `${c.lastName} ${c.firstName}`.trim(), kana: [c.lastNameKana, c.firstNameKana].filter(Boolean).join(' '), visitCount: c.visitCount, points: await pointsBalance(c.id) };
  };

  let initial: CheckoutInitial;
  let transactionId = sp.transactionId ?? null;
  if (!transactionId && sp.appointmentId) {
    const existing = await prisma.transaction.findFirst({ where: { appointmentId: sp.appointmentId, organizationId: ctx.org.id }, select: { id: true } });
    if (existing) transactionId = existing.id;
  }

  if (transactionId) {
    const t = await prisma.transaction.findFirst({ where: { id: transactionId, organizationId: ctx.org.id }, include: { items: { orderBy: { id: 'asc' } }, appointment: { select: { id: true, startAt: true, endAt: true } } } });
    if (!t || !ctx.shops.some((s) => s.id === t.shopId)) return <NotFoundCard message="会計が見つからないか、アクセス権がありません。" />;
    if (t.status !== 'DRAFT') redirect(t.status === 'VOID' ? `/pos/transactions/${t.id}` : `/pos/receipt/${t.id}`);
    const coupon = t.couponId ? await prisma.coupon.findFirst({ where: { id: t.couponId, organizationId: ctx.org.id } }) : null;
    initial = {
      transactionId: t.id, number: t.number, shopId: t.shopId, appointmentId: t.appointmentId,
      appointmentLabel: t.appointment ? fmtDateTime(t.appointment.startAt) + '〜' : null,
      customer: await cust(t.customerId), staffId: t.staffId, couponId: t.couponId,
      manualDiscount: deriveManualDiscount(t, couponRule(coupon)), pointsToUse: t.pointsUsed, note: t.note ?? '',
      lines: t.items.map((i): DraftLine => ({ kind: i.kind as DraftLine['kind'], menuId: i.menuId, productId: i.productId, name: i.name, unitPrice: i.unitPrice, quantity: i.quantity, discount: i.discount, staffId: i.staffId, nominated: i.nominated })),
    };
  } else if (sp.appointmentId) {
    const appt = await prisma.appointment.findFirst({ where: { id: sp.appointmentId, organizationId: ctx.org.id }, include: { menus: true } });
    if (!appt || !ctx.shops.some((s) => s.id === appt.shopId)) return <NotFoundCard message="予約が見つからないか、アクセス権がありません。" />;
    const { lines, coupon } = await appointmentLines(ctx.org.id, appt);
    const shopTz = ctx.shops.find((s) => s.id === appt.shopId)!.timezone;
    initial = {
      transactionId: null, number: null, shopId: appt.shopId, appointmentId: appt.id,
      appointmentLabel: `${fmtDateTime(appt.startAt, shopTz).slice(0, 10)} ${fmtRange(appt.startAt, appt.endAt, shopTz)}`,
      customer: await cust(appt.customerId), staffId: appt.staffId, couponId: coupon?.id ?? null, manualDiscount: 0, pointsToUse: 0, note: '', lines,
    };
    if (!initial.customer && appt.guestName) initial.guestName = appt.guestName;
  } else {
    initial = {
      transactionId: null, number: null, shopId: ctx.shop.id, appointmentId: null, appointmentLabel: null,
      customer: sp.customerId ? await cust(sp.customerId) : null, staffId: null, couponId: null, manualDiscount: 0, pointsToUse: 0, note: '', lines: [],
    };
    if (sp.customerId && !initial.customer) return <NotFoundCard message="お客様が見つかりません。" />;
  }

  const shop = ctx.shops.find((s) => s.id === initial.shopId)!;
  const now = new Date();
  const [menus, products, staff, coupons, register, modes] = await Promise.all([
    prisma.menu.findMany({ where: { shopId: shop.id, active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true, category: true, price: true, durationMin: true } }),
    prisma.product.findMany({ where: { organizationId: ctx.org.id, active: true }, orderBy: [{ brand: 'asc' }, { name: 'asc' }], select: { id: true, name: true, brand: true, price: true, stock: true, sku: true } }),
    prisma.staffAssignment.findMany({ where: { shopId: shop.id, membership: { active: true } }, include: { membership: { select: { userId: true, displayName: true, sortOrder: true } } } }),
    prisma.coupon.findMany({
      where: { shopId: shop.id, organizationId: ctx.org.id, active: true, AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: now } }] }, { OR: [{ validTo: null }, { validTo: { gte: now } }] }] },
      orderBy: { createdAt: 'desc' }, select: { id: true, name: true, discountType: true, discountValue: true, menuIds: true, newCustomerOnly: true },
    }),
    currentRegister(shop.id),
    providerModes(ctx.org.id, shop.id),
  ]);
  // keep a coupon already on the ticket selectable even if it just expired (server re-validates)
  if (initial.couponId && !coupons.some((c) => c.id === initial.couponId)) {
    const c = await prisma.coupon.findFirst({ where: { id: initial.couponId, organizationId: ctx.org.id }, select: { id: true, name: true, discountType: true, discountValue: true, menuIds: true, newCustomerOnly: true } });
    if (c) coupons.unshift(c);
  }
  const staffList = staff.map((s) => s.membership).sort((a, b) => a.sortOrder - b.sortOrder).map((m) => ({ id: m.userId, name: m.displayName }));
  if (!initial.staffId && staffList.some((s) => s.id === ctx.user.id)) initial.defaultStaffId = ctx.user.id;

  return (
    <>
      <PageHeader
        title={initial.number ? `会計 No.${initial.number}` : '会計'}
        sub={[shop.name, initial.appointmentLabel ? `予約 ${initial.appointmentLabel}` : '飛び込み・物販'].join(' ・ ')}
        back={{ href: '/pos', label: 'POS' }}
      />
      <CheckoutClient
        key={initial.transactionId ?? initial.appointmentId ?? 'new'}
        initial={initial}
        shop={{ id: shop.id, name: shop.name, taxRatePct: shop.taxRatePct, pointRatePct: shop.pointRatePct }}
        menus={menus} products={products} staff={staffList}
        coupons={coupons.map((c) => ({ ...c, discountType: c.discountType === 'PERCENT' ? 'PERCENT' : 'AMOUNT' }))}
        registerOpen={!!register} providers={modes}
        canSearchCustomers={ctx.can('customer.read')}
      />
    </>
  );
}
