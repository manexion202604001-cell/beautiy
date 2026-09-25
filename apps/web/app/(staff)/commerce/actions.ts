'use server';
import { z } from 'zod';
import { requireStaff } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';
import { AppError, NotFoundError, runAction, type ActionResult } from '@/lib/server/errors';
import { fileUrl, objectKey, putObject, readUpload } from '@/lib/server/storage';
import { sendCustomerMessage } from '@/lib/server/notify';
import { searchPosCustomers } from '@/lib/server/pos';
import {
  adjustStock, createRecommendation, recommendationUrl, transitionOrder, updateSubscription, updateTracking,
} from '@/lib/server/commerce';

const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);

const productSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, '商品名を入力してください').max(120),
  sku: optText(60),
  brand: optText(60),
  description: optText(2000),
  price: z.coerce.number({ invalid_type_error: '価格を入力してください' }).int('整数で入力してください').min(0).max(10_000_000),
  stock: z.coerce.number().int().min(0).max(1_000_000).optional(),
  subscriptionIntervalDays: z.string().optional().transform((v, c) => {
    if (!v) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 7 || n > 365) { c.addIssue({ code: 'custom', message: '定期便の間隔は7〜365日で指定してください' }); return z.NEVER; }
    return n;
  }),
  active: z.string().optional().transform((v) => v === 'on'),
  onlineSale: z.string().optional().transform((v) => v === 'on'),
  removeImage: z.string().optional().transform((v) => v === 'on'),
});

export async function saveProductAction(_: ActionResult<{ id: string }> | null, fd: FormData): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const ctx = await requireStaff('commerce.manage');
    const input = productSchema.parse(Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === 'string')));
    const upload = await readUpload(fd.get('image') as File | null);
    if (upload && !upload.contentType.startsWith('image/')) throw new AppError('商品画像は画像ファイルを選択してください');
    if (input.sku) {
      const dup = await prisma.product.findFirst({ where: { organizationId: ctx.org.id, sku: input.sku, id: input.id ? { not: input.id } : undefined } });
      if (dup) return { ok: false, error: '入力内容を確認してください', fieldErrors: { sku: `SKU「${input.sku}」は「${dup.name}」で使用されています` } };
    }
    let imageUrl: string | null | undefined;
    if (upload) {
      const key = objectKey(ctx.org.id, 'public', upload.ext);
      await putObject(ctx.org.id, key, upload.data, upload.contentType);
      imageUrl = fileUrl(key);
    } else if (input.removeImage) imageUrl = null;

    const data = {
      name: input.name, sku: input.sku, brand: input.brand, description: input.description, price: input.price,
      subscriptionIntervalDays: input.subscriptionIntervalDays, active: input.active, onlineSale: input.onlineSale,
      ...(imageUrl !== undefined ? { imageUrl } : {}),
    };
    if (input.id) {
      const cur = await prisma.product.findFirst({ where: { id: input.id, organizationId: ctx.org.id } });
      if (!cur) throw new NotFoundError('商品が見つかりません');
      await prisma.product.update({ where: { id: cur.id }, data });
      await audit(ctx, 'commerce.product.update', 'Product', cur.id, { price: [cur.price, input.price], active: input.active, onlineSale: input.onlineSale });
      return { ok: true, message: '商品を保存しました', data: { id: cur.id } };
    }
    const p = await prisma.product.create({ data: { ...data, organizationId: ctx.org.id, stock: input.stock ?? 0 } });
    await audit(ctx, 'commerce.product.create', 'Product', p.id, { name: p.name, stock: p.stock });
    return { ok: true, message: '商品を登録しました', data: { id: p.id } };
  });
}

export async function adjustStockAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('commerce.manage');
    const input = z.object({
      productId: z.string().min(1),
      mode: z.enum(['in', 'out', 'set']),
      quantity: z.coerce.number({ invalid_type_error: '数量を入力してください' }).int('整数で入力してください').min(0).max(1_000_000),
      reason: z.string().trim().min(1, '理由を入力してください').max(200),
    }).parse(Object.fromEntries(fd));
    const p = await prisma.product.findFirst({ where: { id: input.productId, organizationId: ctx.org.id } });
    if (!p) throw new NotFoundError('商品が見つかりません');
    const delta = input.mode === 'in' ? input.quantity : input.mode === 'out' ? -input.quantity : input.quantity - p.stock;
    if (delta === 0) throw new AppError('在庫数に変更がありません');
    const u = await adjustStock({ orgId: ctx.org.id, userId: ctx.user.id }, p.id, delta, input.reason);
    return { ok: true, message: `在庫を ${delta > 0 ? '+' : ''}${delta} 調整しました（現在 ${u.stock}）` };
  });
}

export async function orderStatusAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('commerce.manage');
    const input = z.object({
      orderId: z.string().min(1),
      to: z.enum(['PAID', 'FULFILLED', 'CANCELLED', 'REFUNDED']),
      trackingNumber: z.string().trim().max(60).optional(),
      restock: z.string().optional(),
      reason: z.string().trim().max(300).optional(),
    }).parse(Object.fromEntries(fd));
    await transitionOrder({ orgId: ctx.org.id, userId: ctx.user.id }, input.orderId, input.to, { trackingNumber: input.trackingNumber, restock: input.restock === 'on', reason: input.reason });
    const label = { PAID: '支払い済みにしました', FULFILLED: '発送済みにしました', CANCELLED: '注文をキャンセルしました', REFUNDED: '返金済みにしました' }[input.to];
    return { ok: true, message: label };
  });
}

export async function trackingAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('commerce.manage');
    const orderId = z.string().min(1).parse(fd.get('orderId'));
    const tracking = z.string().trim().max(60).parse(fd.get('trackingNumber') ?? '');
    await updateTracking({ orgId: ctx.org.id, userId: ctx.user.id }, orderId, tracking || null);
    return { ok: true, message: '追跡番号を保存しました' };
  });
}

export async function subscriptionAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('commerce.manage');
    const input = z.object({ id: z.string().min(1), action: z.enum(['pause', 'resume', 'cancel', 'shipped', 'reschedule']), nextShipAt: z.string().optional() }).parse(Object.fromEntries(fd));
    const next = input.nextShipAt ? new Date(`${input.nextShipAt}T09:00:00+09:00`) : undefined;
    await updateSubscription({ orgId: ctx.org.id, userId: ctx.user.id }, input.id, input.action, next);
    return { ok: true };
  });
}

export async function subscriptionFormAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await subscriptionAction(fd);
  return r.ok ? { ok: true, message: '次回お届け日を変更しました' } : r;
}

export async function commerceCustomerSearch(q: string) {
  const ctx = await requireStaff('commerce.manage');
  if (!ctx.can('customer.read')) return [];
  const rows = await searchPosCustomers(ctx.org.id, String(q ?? '').slice(0, 60), 10);
  return rows.map((r) => ({ id: r.id, name: `${r.lastName} ${r.firstName}`.trim(), kana: [r.lastNameKana, r.firstNameKana].filter(Boolean).join(' '), visitCount: r.visitCount }));
}

export async function createRecommendationAction(_: ActionResult<{ url: string; sent: string | null }> | null, fd: FormData): Promise<ActionResult<{ url: string; sent: string | null }>> {
  return runAction(async () => {
    const ctx = await requireStaff('commerce.manage');
    const input = z.object({
      customerId: z.string().optional().transform((v) => v || null),
      staffId: z.string().min(1, '担当スタッフを選択してください'),
      message: z.string().trim().max(1000).optional(),
      send: z.string().optional(),
    }).parse(Object.fromEntries([...fd.entries()].filter(([k]) => k !== 'productIds')));
    const productIds = fd.getAll('productIds').map(String).filter(Boolean);
    const rec = await createRecommendation({ orgId: ctx.org.id, userId: ctx.user.id, shopIds: ctx.shops.map((s) => s.id) }, {
      shopId: ctx.shop.id, staffId: input.staffId, customerId: input.customerId, productIds, message: input.message ?? null,
    });
    const url = recommendationUrl(rec.token);
    let sent: string | null = null;
    if (input.send === 'on') {
      if (!input.customerId) throw new AppError('送信するにはお客様を選択してください');
      if (!ctx.can('message.send')) throw new AppError('メッセージ送信の権限がありません');
      const staff = await prisma.membership.findFirst({ where: { organizationId: ctx.org.id, userId: input.staffId }, select: { displayName: true } });
      const body = `${ctx.shop.name}の${staff?.displayName ?? 'スタッフ'}です。おすすめのホームケア商品をご案内します。\n${input.message ? `${input.message}\n` : ''}${url}`;
      const m = await sendCustomerMessage({ orgId: ctx.org.id, shopId: ctx.shop.id, customerId: input.customerId, body, createdById: ctx.user.id, subject: 'おすすめ商品のご案内' });
      sent = m.status === 'SENT' ? `${m.channel === 'LINE' ? 'LINE' : 'メール'}で送信しました` : `送信できませんでした（${m.error ?? m.status}）`;
    }
    return { ok: true, message: 'おすすめリンクを作成しました', data: { url, sent } };
  });
}
