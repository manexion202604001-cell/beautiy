'use server';
import { z } from 'zod';
import { addDays, isDateStr, localToUtc } from '@salonos/core';
import { prisma } from '@/lib/server/db';
import { requireStaff } from '@/lib/server/session';
import { audit } from '@/lib/server/audit';
import { AppError, runAction, type ActionResult } from '@/lib/server/errors';
import { bool } from '../_components/guard';

const menuSchema = z.object({
  id: z.string().optional().transform((v) => v || null),
  category: z.string().trim().min(1, 'カテゴリを入力してください').max(30),
  name: z.string().trim().min(1, 'メニュー名を入力してください').max(80),
  description: z.string().trim().max(500).optional().transform((v) => v || null),
  durationMin: z.coerce.number().int().min(5, '5分以上').max(600, '600分以内').refine((v) => v % 5 === 0, '5分単位で入力してください'),
  price: z.coerce.number().int().min(0, '0円以上').max(1_000_000),
  sortOrder: z.coerce.number().int().min(-1000).max(10000).default(0),
});

export async function saveMenuAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.menu');
    const input = menuSchema.parse(Object.fromEntries(fd));
    const data = {
      category: input.category, name: input.name, description: input.description, durationMin: input.durationMin, price: input.price, sortOrder: input.sortOrder,
      isConsultation: bool(fd, 'isConsultation'), publicBookable: bool(fd, 'publicBookable'), active: bool(fd, 'active'),
    };
    if (input.id) {
      const m = await prisma.menu.findFirst({ where: { id: input.id, organizationId: ctx.org.id, shopId: ctx.shop.id } });
      if (!m) throw new AppError('メニューが見つかりません');
      await prisma.menu.update({ where: { id: m.id }, data });
      await audit(ctx, 'menu.updated', 'Menu', m.id, { name: data.name, price: data.price, active: data.active });
      return { ok: true, message: 'メニューを更新しました' };
    }
    const m = await prisma.menu.create({ data: { ...data, organizationId: ctx.org.id, shopId: ctx.shop.id } });
    await audit(ctx, 'menu.created', 'Menu', m.id, { name: data.name, price: data.price });
    return { ok: true, message: 'メニューを追加しました' };
  });
}

export async function deleteMenuAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.menu');
    const m = await prisma.menu.findFirst({ where: { id: String(fd.get('id') ?? ''), organizationId: ctx.org.id, shopId: ctx.shop.id } });
    if (!m) throw new AppError('メニューが見つかりません');
    const [appts, items] = await Promise.all([
      prisma.appointmentMenu.count({ where: { menuId: m.id } }),
      prisma.transactionItem.count({ where: { menuId: m.id } }),
    ]);
    if (appts || items) throw new AppError('予約・会計で使われたメニューは削除できません。「受付停止」にしてください。');
    await prisma.menu.delete({ where: { id: m.id } });
    await audit(ctx, 'menu.deleted', 'Menu', m.id, { name: m.name });
  });
}

export async function setMenuActiveAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.menu');
    const m = await prisma.menu.findFirst({ where: { id: String(fd.get('id') ?? ''), organizationId: ctx.org.id, shopId: ctx.shop.id } });
    if (!m) throw new AppError('メニューが見つかりません');
    const active = fd.get('active') === '1';
    await prisma.menu.update({ where: { id: m.id }, data: { active } });
    await audit(ctx, 'menu.updated', 'Menu', m.id, { active });
  });
}

const couponSchema = z.object({
  id: z.string().optional().transform((v) => v || null),
  name: z.string().trim().min(1, 'クーポン名を入力してください').max(80),
  description: z.string().trim().max(500).optional().transform((v) => v || null),
  code: z.string().trim().max(30).regex(/^[A-Za-z0-9_-]*$/, 'コードは英数字・ハイフン・アンダースコアで入力してください').optional().transform((v) => (v ? v.toUpperCase() : null)),
  discountType: z.enum(['AMOUNT', 'PERCENT']),
  discountValue: z.coerce.number().int().min(1, '1以上を入力してください'),
  validFrom: z.string().optional().transform((v) => (v && isDateStr(v) ? v : null)),
  validTo: z.string().optional().transform((v) => (v && isDateStr(v) ? v : null)),
}).superRefine((v, c) => {
  if (v.discountType === 'PERCENT' && v.discountValue > 100) c.addIssue({ code: 'custom', path: ['discountValue'], message: '割引率は100%以下にしてください' });
  if (v.discountType === 'AMOUNT' && v.discountValue > 1_000_000) c.addIssue({ code: 'custom', path: ['discountValue'], message: '割引額が大きすぎます' });
  if (v.validFrom && v.validTo && v.validTo < v.validFrom) c.addIssue({ code: 'custom', path: ['validTo'], message: '終了日は開始日以降にしてください' });
});

export async function saveCouponAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.menu');
    const input = couponSchema.parse(Object.fromEntries(fd));
    const tz = ctx.shop.timezone;
    const requested = fd.getAll('menuIds').map(String).filter(Boolean);
    const valid = requested.length ? await prisma.menu.findMany({ where: { id: { in: requested }, shopId: ctx.shop.id }, select: { id: true } }) : [];
    if (valid.length !== new Set(requested).size) throw new AppError('対象メニューが正しくありません');
    const data = {
      name: input.name, description: input.description, code: input.code, discountType: input.discountType, discountValue: input.discountValue,
      menuIds: valid.map((m) => m.id), newCustomerOnly: bool(fd, 'newCustomerOnly'), publicBookable: bool(fd, 'publicBookable'), active: bool(fd, 'active'),
      validFrom: input.validFrom ? localToUtc(input.validFrom, 0, tz) : null,
      validTo: input.validTo ? new Date(localToUtc(addDays(input.validTo, 1), 0, tz).getTime() - 1000) : null,
    };
    if (input.id) {
      const c = await prisma.coupon.findFirst({ where: { id: input.id, organizationId: ctx.org.id, shopId: ctx.shop.id } });
      if (!c) throw new AppError('クーポンが見つかりません');
      await prisma.coupon.update({ where: { id: c.id }, data });
      await audit(ctx, 'coupon.updated', 'Coupon', c.id, { name: data.name, active: data.active });
      return { ok: true, message: 'クーポンを更新しました' };
    }
    const c = await prisma.coupon.create({ data: { ...data, organizationId: ctx.org.id, shopId: ctx.shop.id } });
    await audit(ctx, 'coupon.created', 'Coupon', c.id, { name: data.name });
    return { ok: true, message: 'クーポンを追加しました' };
  });
}

export async function deleteCouponAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.menu');
    const c = await prisma.coupon.findFirst({ where: { id: String(fd.get('id') ?? ''), organizationId: ctx.org.id, shopId: ctx.shop.id } });
    if (!c) throw new AppError('クーポンが見つかりません');
    const [appts, txs] = await Promise.all([prisma.appointment.count({ where: { couponId: c.id } }), prisma.transaction.count({ where: { couponId: c.id } })]);
    if (appts || txs) throw new AppError('予約・会計で使われたクーポンは削除できません。「無効」にしてください。');
    await prisma.coupon.delete({ where: { id: c.id } });
    await audit(ctx, 'coupon.deleted', 'Coupon', c.id, { name: c.name });
  });
}
