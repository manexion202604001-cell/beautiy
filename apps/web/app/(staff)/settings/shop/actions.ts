'use server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { requireStaff } from '@/lib/server/session';
import { audit } from '@/lib/server/audit';
import { AppError, runAction, type ActionResult } from '@/lib/server/errors';

const RESERVED = new Set(['admin', 'api', 'book', 'booking', 'login', 'signup', 'settings', 'dashboard', 'invite', 'new', 'static', 'www']);

const schema = z.object({
  name: z.string().trim().min(1, '店舗名を入力してください').max(80),
  phone: z.string().trim().max(30).optional().transform((v) => v || null),
  address: z.string().trim().max(200).optional().transform((v) => v || null),
  slug: z.string().trim().toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, '英小文字・数字・ハイフン（先頭と末尾は英数字、40文字以内）で入力してください')
    .refine((s) => !RESERVED.has(s), 'このURLは使用できません'),
  seatCount: z.coerce.number().int().min(1, '1以上').max(100, '100以下'),
  bookingMode: z.enum(['INSTANT', 'REQUEST']),
  slotIntervalMin: z.coerce.number().int().refine((v) => [10, 15, 20, 30, 60].includes(v), '10/15/20/30/60分から選択してください'),
  bookingHorizonDays: z.coerce.number().int().min(1).max(365, '365日以内'),
  minNoticeMin: z.coerce.number().int().min(0).max(10080, '7日（10080分）以内'),
  cancelDeadlineHours: z.coerce.number().int().min(0).max(720, '30日（720時間）以内'),
  taxRatePct: z.coerce.number().int().min(0).max(30),
  pointRatePct: z.coerce.number().int().min(0).max(100),
});

export async function updateShopAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.shop');
    const input = schema.parse(Object.fromEntries(fd));
    const shop = await prisma.shop.findFirst({ where: { id: ctx.shop.id, organizationId: ctx.org.id } });
    if (!shop) throw new AppError('店舗が見つかりません');
    if (input.slug !== shop.slug) {
      const taken = await prisma.shop.findUnique({ where: { slug: input.slug } });
      if (taken) return { ok: false, error: 'このURLは既に使われています', fieldErrors: { slug: 'このURLは既に使われています' } };
    }
    const changed = Object.fromEntries(Object.entries(input).filter(([k, v]) => (shop as any)[k] !== v));
    try {
      await prisma.shop.update({ where: { id: shop.id }, data: input });
    } catch (e: any) {
      if (e?.code === 'P2002') return { ok: false, error: 'このURLは既に使われています' };
      throw e;
    }
    await audit(ctx, 'shop.updated', 'Shop', shop.id, { changed: Object.keys(changed) });
    return { ok: true, message: '店舗設定を保存しました' };
  });
}
