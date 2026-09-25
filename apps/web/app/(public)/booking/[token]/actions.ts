'use server';
import { z } from 'zod';
import { requestMeta } from '@/lib/server/session';
import { AppError, runAction, type ActionResult } from '@/lib/server/errors';
import { publicCancel, publicReschedule, rateLimit } from '@/lib/server/reservations';

export type ManageResult = ActionResult & { code?: string };

async function guard(prefix: string) {
  const { ip } = await requestMeta().catch(() => ({ ip: null }));
  if (!rateLimit(`${prefix}:${ip ?? 'unknown'}`, 20, 10 * 60_000)) throw new AppError('操作が集中しています。しばらくしてから再度お試しください。');
}

export async function cancelBookingAction(token: string, reason: string): Promise<ManageResult> {
  return runAction(async () => {
    await guard('manage-cancel');
    await publicCancel(z.string().min(1).max(80).parse(token), z.string().max(300).parse(reason ?? ''));
    return { ok: true, message: 'ご予約をキャンセルしました' };
  });
}

export async function rescheduleBookingAction(token: string, startAt: string): Promise<ManageResult> {
  return runAction(async () => {
    await guard('manage-change');
    try {
      await publicReschedule({ token, startAt });
    } catch (e: any) {
      if (e?.code === 'BOOKING_CONFLICT') return { ok: false, error: 'この時間は埋まってしまいました。別の時間をお選びください。', code: e.reason } as ManageResult;
      throw e;
    }
    return { ok: true, message: 'ご予約の日時を変更しました' };
  });
}
