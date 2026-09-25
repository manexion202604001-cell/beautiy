'use server';
import { z } from 'zod';
import { runAction, type ActionResult } from '@/lib/server/errors';
import { submitReview } from '@/lib/server/reviews';

const schema = z.object({
  rating: z.coerce.number({ invalid_type_error: '評価を選択してください' }).int().min(1, '評価を選択してください').max(5),
  title: z.string().trim().max(80, 'タイトルは80文字以内で入力してください').optional(),
  body: z.string().trim().max(2000, '本文は2000文字以内で入力してください').optional(),
  authorName: z.string().trim().min(1, '表示名を入力してください').max(40, '表示名は40文字以内で入力してください'),
});

export async function submitReviewAction(token: string, _: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const input = schema.parse({ rating: fd.get('rating') ?? undefined, title: fd.get('title') ?? undefined, body: fd.get('body') ?? undefined, authorName: fd.get('authorName') ?? '' });
    await submitReview(String(token), input);
    return { ok: true, message: 'ご投稿ありがとうございました' };
  });
}
