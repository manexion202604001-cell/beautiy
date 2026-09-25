// Reviews: public submission (by appointment manage token), stats, external sync.
import type { Prisma } from '@salonos/db';
import { prisma } from './db';
import { AppError, NotFoundError } from './errors';
import { googleReviewAdapter } from './adapters/google';

/** Customers can review a completed visit for this many days. */
export const REVIEW_WINDOW_DAYS = 90;

export interface ReviewInput { rating: number; title?: string | null; body?: string | null; authorName: string }

export async function reviewableAppointment(token: string) {
  if (!token || token.length > 64) return null;
  const a = await prisma.appointment.findUnique({
    where: { manageToken: token },
    // Public page: never load the customer record; the page only shows what the booker typed (guestName).
    include: { shop: true, menus: true },
  });
  if (!a) return null;
  const existing = await prisma.review.findUnique({ where: { appointmentId: a.id } });
  const staff = a.staffId ? await prisma.membership.findFirst({ where: { organizationId: a.organizationId, userId: a.staffId } }) : null;
  const expired = Date.now() - a.endAt.getTime() > REVIEW_WINDOW_DAYS * 86400000;
  return { appointment: a, existing, staffName: staff?.displayName ?? null, canReview: a.status === 'COMPLETED' && !existing && !expired, expired };
}

/** One review per appointment (Review.appointmentId unique), only for COMPLETED visits. */
export async function submitReview(token: string, input: ReviewInput) {
  const r = await reviewableAppointment(token);
  if (!r) throw new NotFoundError('ご予約が見つかりません');
  const a = r.appointment;
  if (a.status !== 'COMPLETED') throw new AppError('ご来店後に口コミを投稿いただけます');
  if (r.existing) throw new AppError('このご来店の口コミは投稿済みです');
  if (r.expired) throw new AppError('口コミの投稿期限を過ぎています');
  const rating = Math.round(Number(input.rating));
  if (!(rating >= 1 && rating <= 5)) throw new AppError('評価を選択してください');
  const authorName = input.authorName.trim().slice(0, 40);
  if (!authorName) throw new AppError('表示名を入力してください');
  try {
    return await prisma.review.create({
      data: {
        organizationId: a.organizationId, shopId: a.shopId, staffId: a.staffId, customerId: a.customerId, appointmentId: a.id,
        rating, title: input.title?.trim().slice(0, 80) || null, body: input.body?.trim().slice(0, 2000) || null, authorName, source: 'INTERNAL',
      },
    });
  } catch (e: any) {
    if (e?.code === 'P2002') throw new AppError('このご来店の口コミは投稿済みです');
    throw e;
  }
}

export async function reviewStats(where: Prisma.ReviewWhereInput) {
  const g = await prisma.review.groupBy({ by: ['rating'], where, _count: { _all: true } });
  const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0, sum = 0;
  for (const row of g) { dist[row.rating] = row._count._all; total += row._count._all; sum += row.rating * row._count._all; }
  return { dist, total, average: total ? Math.round((sum / total) * 10) / 10 : 0 };
}

/** Pull reviews from Google Business Profile for a shop (sandbox → none). Upserts by externalRef. */
export async function syncGoogleReviews(orgId: string, shopId: string) {
  const { adapter, integrationId } = await googleReviewAdapter(orgId, shopId);
  let created = 0, updated = 0;
  try {
    const last = await prisma.review.findFirst({ where: { organizationId: orgId, shopId, source: 'GOOGLE' }, orderBy: { createdAt: 'desc' } });
    const items = await adapter.listReviews(last ? new Date(last.createdAt.getTime() - 7 * 86400000) : null);
    for (const n of items) {
      const existing = await prisma.review.findFirst({ where: { organizationId: orgId, source: 'GOOGLE', externalRef: n.externalRef } });
      if (existing) {
        await prisma.review.update({ where: { id: existing.id }, data: { rating: n.rating, body: n.body, authorName: n.authorName, ...(n.reply && !existing.reply ? { reply: n.reply, repliedAt: n.repliedAt } : {}) } });
        updated++;
      } else {
        await prisma.review.create({ data: { organizationId: orgId, shopId, rating: n.rating, body: n.body, authorName: n.authorName, source: 'GOOGLE', externalRef: n.externalRef, createdAt: n.createdAt, reply: n.reply, repliedAt: n.repliedAt } });
        created++;
      }
    }
    if (integrationId) await prisma.integration.update({ where: { id: integrationId }, data: { lastSyncAt: new Date(), lastError: null } });
  } catch (e: any) {
    if (integrationId) await prisma.integration.update({ where: { id: integrationId }, data: { lastError: String(e?.message ?? e).slice(0, 500) } });
    throw new AppError(`Google口コミの取得に失敗しました：${e?.message ?? e}`);
  }
  return { created, updated, sandbox: adapter.sandbox };
}
