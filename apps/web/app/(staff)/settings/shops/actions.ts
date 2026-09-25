'use server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { requireStaff } from '@/lib/server/session';
import { audit } from '@/lib/server/audit';
import { AppError, runAction, type ActionResult } from '@/lib/server/errors';
import { createDefaultShopSetup, uniqueShopSlug } from '@/lib/server/shops';
import { requireOrgAdmin } from '../_components/guard';

const createSchema = z.object({
  name: z.string().trim().min(1, '店舗名を入力してください').max(80),
  seatCount: z.coerce.number().int().min(1).max(100).default(3),
  phone: z.string().trim().max(30).optional().transform((v) => v || null),
  address: z.string().trim().max(200).optional().transform((v) => v || null),
});

export async function createShopAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.shop');
    requireOrgAdmin(ctx);
    const input = createSchema.parse(Object.fromEntries(fd));
    const shop = await prisma.$transaction(async (tx) => {
      const s = await tx.shop.create({ data: { organizationId: ctx.org.id, name: input.name, slug: await uniqueShopSlug(tx, input.name), seatCount: input.seatCount, phone: input.phone, address: input.address } });
      await createDefaultShopSetup(tx, ctx.org.id, s.id);
      await tx.staffAssignment.create({ data: { membershipId: ctx.membership.id, shopId: s.id } });
      return s;
    });
    await audit(ctx, 'shop.created', 'Shop', shop.id, { name: shop.name, slug: shop.slug });
    return { ok: true, message: `「${shop.name}」を作成しました。営業時間とメニューは初期値が設定されています。` };
  });
}

export async function setShopActiveAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.shop');
    requireOrgAdmin(ctx);
    const id = String(fd.get('id') ?? '');
    const active = fd.get('active') === '1';
    const shop = await prisma.shop.findFirst({ where: { id, organizationId: ctx.org.id } });
    if (!shop) throw new AppError('店舗が見つかりません');
    if (!active) {
      const remaining = await prisma.shop.count({ where: { organizationId: ctx.org.id, active: true, id: { not: id } } });
      if (remaining === 0) throw new AppError('最後の店舗は停止できません');
    }
    await prisma.shop.update({ where: { id }, data: { active } });
    await audit(ctx, active ? 'shop.reactivated' : 'shop.deactivated', 'Shop', id, { name: shop.name });
  });
}
