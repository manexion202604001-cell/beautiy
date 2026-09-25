'use server';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '@salonos/core/crypto';
import { prisma } from '@/lib/server/db';
import { requireStaff } from '@/lib/server/session';
import { audit } from '@/lib/server/audit';
import { AppError, runAction, type ActionResult } from '@/lib/server/errors';

const nameSchema = z.object({ displayName: z.string().trim().min(1, '表示名を入力してください').max(40, '表示名は40文字以内にしてください') });

export async function updateProfileAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff();
    const { displayName } = nameSchema.parse(Object.fromEntries(fd));
    await prisma.$transaction([
      prisma.membership.update({ where: { id: ctx.membership.id }, data: { displayName } }),
      prisma.user.update({ where: { id: ctx.user.id }, data: { name: displayName } }),
    ]);
    await audit(ctx, 'account.profile_updated', 'User', ctx.user.id);
    return { ok: true, message: '表示名を更新しました' };
  });
}

const pwSchema = z.object({
  current: z.string().min(1, '現在のパスワードを入力してください'),
  next: z.string().min(8, '新しいパスワードは8文字以上にしてください').max(200),
  confirm: z.string(),
}).refine((v) => v.next === v.confirm, { message: '確認用パスワードが一致しません', path: ['confirm'] });

// Per-instance throttle against guessing the current password from a hijacked session.
const tries = new Map<string, { n: number; until: number }>();

export async function changePasswordAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff();
    const input = pwSchema.parse(Object.fromEntries(fd));
    const t = tries.get(ctx.user.id);
    if (t && t.until > Date.now() && t.n >= 5) throw new AppError('試行回数が多すぎます。しばらくしてから再度お試しください。');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
    if (!verifyPassword(input.current, user.passwordHash)) {
      tries.set(ctx.user.id, { n: (t && t.until > Date.now() ? t.n : 0) + 1, until: Date.now() + 10 * 60000 });
      await audit(ctx, 'auth.password_change_failed', 'User', ctx.user.id);
      throw new AppError('現在のパスワードが正しくありません');
    }
    if (input.current === input.next) throw new AppError('現在と異なるパスワードを設定してください');
    tries.delete(ctx.user.id);
    await prisma.$transaction([
      prisma.user.update({ where: { id: ctx.user.id }, data: { passwordHash: hashPassword(input.next) } }),
      // sign out every other device
      prisma.session.deleteMany({ where: { userId: ctx.user.id, id: { not: ctx.sessionId } } }),
    ]);
    await audit(ctx, 'auth.password_changed', 'User', ctx.user.id);
    return { ok: true, message: 'パスワードを変更しました。他の端末ではログアウトされました。' };
  });
}
