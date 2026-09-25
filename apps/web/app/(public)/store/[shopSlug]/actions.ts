'use server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { runAction, type ActionResult } from '@/lib/server/errors';
import { createStoreOrder, orderUrl } from '@/lib/server/commerce';

const schema = z.object({
  shopSlug: z.string().min(1).max(80),
  items: z.array(z.object({ productId: z.string().min(1).max(40), quantity: z.number().int().min(1).max(99) })).min(1, 'カートが空です').max(50),
  name: z.string().trim().min(1, 'お名前を入力してください').max(60),
  email: z.string().trim().toLowerCase().email('メールアドレスの形式が正しくありません').max(200),
  phone: z.string().trim().regex(/^[0-9０-９+\-()（） ]{10,16}$/, '電話番号を正しく入力してください'),
  postalCode: z.string().trim().regex(/^(\d{3}-?\d{4})?$/, '郵便番号は7桁で入力してください').optional(),
  address: z.string().trim().min(5, 'お届け先住所を入力してください').max(200),
  subscribe: z.boolean().optional(),
  rec: z.string().regex(/^[\w-]{6,64}$/).nullish(),
  website: z.string().max(0).optional(), // honeypot
});

// Best-effort per-instance throttle against order spam.
const hits = new Map<string, number[]>();

export async function placeOrderAction(input: z.input<typeof schema>): Promise<ActionResult<{ url: string; external: boolean }>> {
  return runAction<{ url: string; external: boolean }>(async () => {
    const data = schema.parse(input);
    const ip = ((await headers()).get('x-forwarded-for') ?? '').split(',')[0].trim() || 'local';
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 10 * 60000);
    if (recent.length >= 10) return { ok: false, error: '短時間に多くの注文が行われました。しばらくしてから再度お試しください。' };
    hits.set(ip, [...recent, now]);
    const r = await createStoreOrder({ ...data, postalCode: data.postalCode || null, recToken: data.rec ?? null });
    if (r.redirectUrl) return { ok: true, data: { url: r.redirectUrl, external: true } };
    return { ok: true, data: { url: orderUrl(data.shopSlug, r.orderId), external: false } };
  });
}
