'use server';
import { z } from 'zod';
import { requestMeta } from '@/lib/server/session';
import { AppError, runAction, type ActionResult } from '@/lib/server/errors';
import { publicBook, publicHold, rateLimit, releaseHold, type PublicBookingInput } from '@/lib/server/reservations';

export type PublicResult<T = undefined> = ActionResult<T> & { code?: string };

async function ipKey(prefix: string) {
  const { ip } = await requestMeta().catch(() => ({ ip: null }));
  return `${prefix}:${ip ?? 'unknown'}`;
}

async function run<T>(fn: () => Promise<ActionResult<T> | void>): Promise<PublicResult<T>> {
  return runAction<T>(async () => {
    try {
      return await fn();
    } catch (e: any) {
      if (e?.code === 'BOOKING_CONFLICT' && e?.reason) {
        const taken = ['STAFF_CONFLICT', 'SEAT_CAPACITY', 'NO_STAFF'].includes(e.reason);
        return { ok: false, error: taken ? 'この時間は埋まってしまいました。お手数ですが別の時間をお選びください。' : e.message, code: e.reason } as PublicResult<T>;
      }
      throw e;
    }
  });
}

export async function holdSlotAction(input: { shopSlug: string; menuIds: string[]; staffId: string | null; startAt: string; previousToken?: string | null }): Promise<PublicResult<{ token: string; expiresAt: string }>> {
  return run(async () => {
    if (!rateLimit(await ipKey('hold'), 40, 10 * 60_000)) throw new AppError('操作が集中しています。しばらくしてから再度お試しください。');
    const h = await publicHold(input);
    return { ok: true, data: { token: h.token, expiresAt: h.expiresAt.toISOString() } };
  });
}

export async function releaseHoldAction(token: string | null): Promise<ActionResult> {
  return runAction(async () => {
    await releaseHold(z.string().max(80).nullable().parse(token));
  });
}

export async function submitBookingAction(input: PublicBookingInput): Promise<PublicResult<{ manageToken: string; status: string }>> {
  return run(async () => {
    if (!rateLimit(await ipKey('book'), 12, 10 * 60_000)) throw new AppError('短時間に多くのご予約が送信されました。しばらくしてから再度お試しください。');
    const r = await publicBook(input);
    return { ok: true, data: { manageToken: r.manageToken, status: r.status } };
  });
}
