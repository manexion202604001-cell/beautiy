'use server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { assertShop, requireStaff, type StaffContext } from '@/lib/server/session';
import { audit } from '@/lib/server/audit';
import { manageableMember, staffActorOf } from '@/lib/server/staff-access';
import { AppError, NotFoundError, runAction, type ActionResult } from '@/lib/server/errors';
import { deleteObject, fileUrl, objectKey, putObject, readUpload } from '@/lib/server/storage';
import { syncGoogleReviews } from '@/lib/server/reviews';
import { googleReviewAdapter } from '@/lib/server/adapters/google';
import { normalizeInstagramUrl } from '@/lib/server/adapters/instagram';

const id = z.string().min(1).max(64);

async function ownReview(ctx: StaffContext, reviewId: string) {
  const r = await prisma.review.findFirst({ where: { id: reviewId, organizationId: ctx.org.id, shopId: { in: ctx.shops.map((s) => s.id) } } });
  if (!r) throw new NotFoundError('口コミが見つかりません');
  return r;
}

export async function replyReviewAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('review.reply');
    const input = z.object({ reviewId: id, reply: z.string().trim().max(2000, '返信は2000文字以内で入力してください') }).parse(Object.fromEntries(fd));
    const review = await ownReview(ctx, input.reviewId);
    const reply = input.reply || null;
    await prisma.review.update({ where: { id: review.id }, data: reply ? { reply, repliedAt: new Date(), repliedById: ctx.user.id } : { reply: null, repliedAt: null, repliedById: null } });
    await audit(ctx, reply ? 'review.reply' : 'review.reply.delete', 'Review', review.id, { source: review.source });
    if (reply && review.source === 'GOOGLE' && review.externalRef) {
      const { adapter } = await googleReviewAdapter(ctx.org.id, review.shopId);
      const r = await adapter.replyToReview(review.externalRef, reply);
      if (!r.ok) return { ok: false, error: `返信を保存しましたが、Googleへの反映に失敗しました（${r.error}）。時間をおいて再度保存してください。` };
      return { ok: true, message: adapter.sandbox ? '返信を保存しました（Google連携未設定のため反映はスキップ）' : '返信を保存し、Googleに反映しました' };
    }
    return { ok: true, message: reply ? '返信を保存しました' : '返信を削除しました' };
  });
}

export async function setReviewPublishedAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('review.reply');
    const input = z.object({ reviewId: id, published: z.enum(['true', 'false']) }).parse(Object.fromEntries(fd));
    const review = await ownReview(ctx, input.reviewId);
    const published = input.published === 'true';
    await prisma.review.update({ where: { id: review.id }, data: { published } });
    await audit(ctx, published ? 'review.publish' : 'review.hide', 'Review', review.id);
    return { ok: true, message: published ? '公開しました' : '非公開にしました' };
  });
}

export async function syncGoogleReviewsAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('review.reply');
    const shopId = id.parse(fd.get('shopId'));
    assertShop(ctx, shopId);
    const r = await syncGoogleReviews(ctx.org.id, shopId);
    await audit(ctx, 'review.sync.google', 'Shop', shopId, r);
    if (r.sandbox) return { ok: true, message: 'Googleビジネスプロフィールが未連携のため、新しい口コミはありません（設定 > 連携で接続できます）' };
    return { ok: true, message: `同期しました：新規 ${r.created}件 / 更新 ${r.updated}件` };
  });
}

// ───────────────────────── Profiles ─────────────────────────

const optUrl = z.string().trim().max(300).optional().or(z.literal('')).refine((v) => !v || /^https?:\/\/[^\s]+$/i.test(v), 'http(s)から始まるURLを入力してください');

async function uploadPublicImage(orgId: string, file: FormDataEntryValue | null): Promise<string | null> {
  const up = await readUpload(file instanceof File ? file : null);
  if (!up) return null;
  if (!up.contentType.startsWith('image/')) throw new AppError('画像ファイル（JPEG/PNG/WebP/GIF）を選択してください');
  const key = objectKey(orgId, 'public', up.ext);
  await putObject(orgId, key, up.data, up.contentType);
  return fileUrl(key);
}

async function removeOldImage(orgId: string, url: string | null | undefined) {
  const prefix = `/api/files/org/${orgId}/public/`;
  if (url && url.startsWith(prefix)) await deleteObject(url.slice('/api/files/'.length)).catch(() => undefined);
}

const shopProfileSchema = z.object({
  shopId: id,
  description: z.string().trim().max(2000, '2000文字以内で入力してください'),
  accessInfo: z.string().trim().max(1000, '1000文字以内で入力してください'),
  hygieneInfo: z.string().trim().max(2000, '2000文字以内で入力してください'),
  instagramUrl: z.string().trim().max(200),
  websiteUrl: optUrl,
  removeImage: z.string().optional(),
});

export async function saveShopProfileAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('profile.edit');
    if (!ctx.can('settings.shop')) throw new AppError('店舗情報の編集権限がありません');
    const input = shopProfileSchema.parse(Object.fromEntries(fd));
    assertShop(ctx, input.shopId);
    const shop = await prisma.shop.findFirst({ where: { id: input.shopId, organizationId: ctx.org.id } });
    if (!shop) throw new NotFoundError('店舗が見つかりません');
    const instagramUrl = input.instagramUrl ? normalizeInstagramUrl(input.instagramUrl) : null;
    if (input.instagramUrl && !instagramUrl) return { ok: false, error: 'InstagramのURLまたはユーザー名が正しくありません', fieldErrors: { instagramUrl: '例）https://www.instagram.com/yoursalon/ または @yoursalon' } };
    const newImage = await uploadPublicImage(ctx.org.id, fd.get('image'));
    let imageUrl: string | null | undefined;
    if (newImage) { await removeOldImage(ctx.org.id, shop.imageUrl); imageUrl = newImage; } else if (input.removeImage === 'on') { await removeOldImage(ctx.org.id, shop.imageUrl); imageUrl = null; }
    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        description: input.description || null, accessInfo: input.accessInfo || null, hygieneInfo: input.hygieneInfo || null,
        instagramUrl, websiteUrl: input.websiteUrl || null, ...(imageUrl !== undefined ? { imageUrl } : {}),
      },
    });
    await audit(ctx, 'shop.profile.update', 'Shop', shop.id, { image: imageUrl !== undefined });
    return { ok: true, message: '店舗プロフィールを保存しました' };
  });
}

const staffProfileSchema = z.object({
  membershipId: z.string().max(64).optional().or(z.literal('')),
  publicBio: z.string().trim().max(1500, '1500文字以内で入力してください'),
  specialties: z.string().trim().max(200, '200文字以内で入力してください'),
  instagramUrl: z.string().trim().max(200),
  removeImage: z.string().optional(),
});

export async function saveStaffProfileAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('profile.edit');
    const input = staffProfileSchema.parse(Object.fromEntries(fd));
    const targetId = input.membershipId || ctx.membership.id;
    if (targetId !== ctx.membership.id && !ctx.can('settings.staff')) throw new AppError('他のスタッフのプロフィールを編集する権限がありません');
    // Own profile always; others only with the same rank + shop rule as staff settings.
    const m = await manageableMember(staffActorOf(ctx), targetId, { allowSelf: true, message: '他のスタッフのプロフィールを編集する権限がありません' });
    const instagramUrl = input.instagramUrl ? normalizeInstagramUrl(input.instagramUrl) : null;
    if (input.instagramUrl && !instagramUrl) return { ok: false, error: 'InstagramのURLまたはユーザー名が正しくありません', fieldErrors: { instagramUrl: '例）@stylist_name' } };
    const newImage = await uploadPublicImage(ctx.org.id, fd.get('image'));
    let imageUrl: string | null | undefined;
    if (newImage) { await removeOldImage(ctx.org.id, m.imageUrl); imageUrl = newImage; } else if (input.removeImage === 'on') { await removeOldImage(ctx.org.id, m.imageUrl); imageUrl = null; }
    await prisma.membership.update({
      where: { id: m.id },
      data: { publicBio: input.publicBio || null, specialties: input.specialties || null, instagramUrl, ...(imageUrl !== undefined ? { imageUrl } : {}) },
    });
    await audit(ctx, 'staff.profile.update', 'Membership', m.id, { self: m.id === ctx.membership.id });
    return { ok: true, message: 'スタイリストプロフィールを保存しました' };
  });
}
