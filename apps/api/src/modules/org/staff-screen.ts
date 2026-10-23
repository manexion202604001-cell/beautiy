/**
 * スタッフ screen (main menu 「スタッフ」): what that screen needs on top of the staff CRUD in service.ts.
 *  - the shop's staff with photo, login state, LINE notification, visibility and 担当顧客 count
 *  - ニックネーム / プロフィール写真 / LINE通知
 *  - ログイン情報 (e-mail + password set by a manager)
 *  - 並び替え (↑↓)
 *  - LINE通知: a new booking is pushed to the staff member's LINE through the shop's official account
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { accessibleShopIds, auditUserId, requirePermission, type Ctx } from '../../auth/actor.js';
import { invalidateActorCache } from '../../auth/load-actor.js';
import { withSystem } from '../../db/tenant.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { audit } from '../../lib/audit.js';
import { hashPassword } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import { onEvent } from '../../lib/events.js';
import { idParam, uuid } from '../../lib/schemas.js';
import { revokeUserSessions } from '../auth/api.js';
import { formatJst } from '../../lib/time.js';
import { getAttachableFile } from '../files/api.js';
import { channelForShop } from '../messaging/channels.js';
import '../messaging/line-id-check.js';
import { linePush, textMessage } from '../messaging/providers/line.js';
import { getAppointmentUnchecked } from '../appointments/service.js';
import { passwordSchema } from './schemas.js';
import { getShop, getStaff, listStaff } from './service.js';

const NO_ID = '00000000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------- staff of the shop

/** Every staff member of the shop (在籍 → 退職 is ordered by the screen), with what the rows show */
export async function shopStaffDirectory(ctx: Ctx, shopId: string) {
  await getShop(ctx, shopId); // 404 for a shop of another organization
  const staff = await listStaff(ctx, { shopId, includeInactive: true });
  if (!staff.length) return [];
  const ids = staff.map((s) => s.id);
  const userIds = staff.map((s) => s.user_id).filter((x): x is string => !!x);
  const [extras, users, counts] = await Promise.all([
    ctx.trx.selectFrom('staffs').select(['id', 'notify_line', 'line_user_id']).where('id', 'in', ids).execute(),
    ctx.trx
      .selectFrom('users')
      .select(['id', 'email', sql<boolean>`password_hash IS NOT NULL`.as('has_password')])
      .where('id', 'in', userIds.length ? userIds : [NO_ID])
      .execute(),
    // 担当顧客: the same relation the customer list filters on (customers.primary_staff_id)
    ctx.trx
      .selectFrom('customers')
      .select(['primary_staff_id', sql<number>`count(*)::int`.as('n')])
      .where('primary_staff_id', 'in', ids)
      .where('deleted_at', 'is', null)
      .groupBy('primary_staff_id')
      .execute(),
  ]);
  return staff.map((s) => {
    const user = users.find((u) => u.id === s.user_id);
    const extra = extras.find((e) => e.id === s.id);
    const profile = (s.public_profile ?? {}) as Record<string, unknown>;
    return {
      ...s,
      nickname: typeof profile.nickname === 'string' ? profile.nickname : null,
      /** e-mail address the staff member logs in with (null = no login yet) */
      login_email: user?.email ?? null,
      /** false = cannot log in yet: no account, or the invitation was not accepted (未認証) */
      login_ready: !!user?.has_password,
      notify_line: extra?.notify_line ?? false,
      line_user_id: extra?.line_user_id ?? null,
      is_visible_to_customer: s.shops.find((a) => a.shop_id === shopId)?.is_visible_to_customer ?? true,
      customer_count: counts.find((c) => c.primary_staff_id === s.id)?.n ?? 0,
    };
  });
}

// ---------------------------------------------------------------- nickname / photo / LINE notification

export const staffExtrasSchema = z.object({
  /** 表示名（お客様に表示される名前）; '' or null removes it */
  nickname: z.string().trim().max(50).nullable().optional(),
  /** uploaded file of purpose staff_photo; null removes the photo */
  photoFileId: uuid.nullable().optional(),
  notifyLine: z.boolean().optional(),
  lineUserId: z
    .string()
    .trim()
    .regex(/^U[0-9a-f]{32}$/, 'LINE User ID は「U」で始まる33文字です')
    .nullable()
    .optional(),
});
export type StaffExtrasInput = z.infer<typeof staffExtrasSchema>;

export async function updateStaffExtras(ctx: Ctx, staffId: string, input: StaffExtrasInput) {
  const isSelf = ctx.actor.kind === 'staff' && ctx.actor.staffId === staffId;
  if (!isSelf) requirePermission(ctx.actor, 'staff.manage');
  const before = await getStaff(ctx, staffId);
  const current = await ctx.trx.selectFrom('staffs').select(['notify_line', 'line_user_id']).where('id', '=', staffId).executeTakeFirstOrThrow();
  const notify = input.notifyLine ?? current.notify_line;
  const lineUserId = input.lineUserId === undefined ? current.line_user_id : input.lineUserId;
  if (notify && !lineUserId) throw Errors.validation('LINE通知を受け取るには LINE User ID を入力してください');

  const profile = { ...((before.public_profile ?? {}) as Record<string, unknown>) };
  if (input.nickname !== undefined) {
    if (input.nickname) profile.nickname = input.nickname;
    else delete profile.nickname;
  }
  if (input.photoFileId !== undefined) {
    if (input.photoFileId) {
      await getAttachableFile(ctx, input.photoFileId, ['staff_photo']);
      profile.photoFileId = input.photoFileId;
    } else {
      delete profile.photoFileId;
      delete profile.photo_file_id;
    }
  }
  await ctx.trx
    .updateTable('staffs')
    .set({ public_profile: JSON.stringify(profile), notify_line: notify, line_user_id: lineUserId, updated_by: auditUserId(ctx.actor), trace_id: ctx.meta.traceId ?? null })
    .where('id', '=', staffId)
    .execute();
  await audit(ctx, { action: 'staff.profile_update', resourceType: 'staff', resourceId: staffId, after: input });
  return getStaff(ctx, staffId);
}

// ---------------------------------------------------------------- login (e-mail + password)

export const staffCredentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email('メールアドレスの形式が正しくありません'),
  /** omitted = keep the current password (only the e-mail address changes) */
  password: passwordSchema.optional(),
  /**
   * 「ログイン情報を設定」: the password is a temporary one the manager hands over, so the staff member
   * has to choose their own at the first login. Without it (スタッフ編集) the password is final.
   */
  temporary: z.boolean().optional(),
});
export type StaffCredentialsInput = z.infer<typeof staffCredentialsSchema>;

/**
 * ログイン情報を設定 / スタッフ編集のメールアドレス・パスワード: a manager registers the address and
 * password a staff member logs in with.
 *  - no account yet → one is created and the staff member becomes active
 *  - an account used by another organization as well is never changed here (its owner changes it)
 *  - an owner's login can only be changed by someone allowed to change roles
 */
export async function setStaffCredentials(ctx: Ctx, staffId: string, input: StaffCredentialsInput) {
  const isSelf = ctx.actor.kind === 'staff' && ctx.actor.staffId === staffId;
  requirePermission(ctx.actor, 'staff.manage');
  const staff = await getStaff(ctx, staffId);
  const mine = accessibleShopIds(ctx.actor);
  if (mine && !staff.shops.some((s) => mine.includes(s.shop_id))) throw Errors.notFound('スタッフ', staffId);
  if (staff.role?.key === 'owner' && !isSelf) requirePermission(ctx.actor, 'role.manage');

  const taken = await ctx.trx.selectFrom('users').select('id').where('email', '=', input.email).executeTakeFirst();
  // a password someone else typed is never the final one when it was handed over as temporary
  const mustChange = !!input.temporary && !isSelf;
  let userId = staff.user_id;
  if (userId) {
    if (taken && taken.id !== userId) throw Errors.conflict('EMAIL_TAKEN', 'このメールアドレスは既に別のアカウントで使われています');
    const elsewhere = await withSystem((trx) =>
      trx.selectFrom('staffs').select('id').where('user_id', '=', userId!).where('organization_id', '!=', ctx.actor.organizationId).where('deleted_at', 'is', null).executeTakeFirst(),
    );
    if (elsewhere) throw Errors.forbidden('このアカウントは他の法人でも使われているため、ログイン情報はご本人のみ変更できます', 'SHARED_ACCOUNT');
    const user = await ctx.trx.selectFrom('users').select(['id', 'password_hash']).where('id', '=', userId).executeTakeFirstOrThrow();
    if (!input.password && !user.password_hash) throw Errors.validation('パスワードを入力してください');
    await ctx.trx
      .updateTable('users')
      .set({
        email: input.email,
        ...(input.password
          ? { password_hash: await hashPassword(input.password), failed_login_count: 0, locked_until: null, must_change_password: mustChange }
          : {}),
      })
      .where('id', '=', userId)
      .execute();
    // the previous password no longer opens the account: devices signed in with it sign in again
    if (input.password) await revokeUserSessions(ctx, userId);
  } else {
    if (taken) throw Errors.conflict('EMAIL_TAKEN', 'このメールアドレスは既に別のアカウントで使われています');
    if (!input.password) throw Errors.validation('パスワードを入力してください');
    const user = await ctx.trx
      .insertInto('users')
      .values({ email: input.email, display_name: staff.display_name, password_hash: await hashPassword(input.password), must_change_password: mustChange })
      .returning('id')
      .executeTakeFirstOrThrow();
    userId = user.id;
  }
  await ctx.trx
    .updateTable('staffs')
    .set({
      user_id: userId,
      email: input.email,
      // a pending invitation is settled: the staff member can log in now
      ...(staff.status === 'invited' ? { status: 'active' } : {}),
      updated_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .where('id', '=', staffId)
    .execute();
  invalidateActorCache(staffId);
  await audit(ctx, { action: 'staff.credentials_set', resourceType: 'staff', resourceId: staffId, after: { email: input.email, passwordChanged: !!input.password, temporary: !!input.password && mustChange } });
  return getStaff(ctx, staffId);
}

// ---------------------------------------------------------------- order

/** 並び替え: the given staff of the shop get sort_order 0, 1, 2 … in that order */
export async function reorderStaff(ctx: Ctx, shopId: string, staffIds: string[]) {
  requirePermission(ctx.actor, 'staff.manage');
  await getShop(ctx, shopId);
  if (new Set(staffIds).size !== staffIds.length) throw Errors.validation('同じスタッフが複数回指定されています');
  const assigned = await ctx.trx
    .selectFrom('staff_shop_assignments')
    .select('staff_id')
    .where('shop_id', '=', shopId)
    .where('ended_on', 'is', null)
    .where('staff_id', 'in', staffIds.length ? staffIds : [NO_ID])
    .execute();
  const ok = new Set(assigned.map((a) => a.staff_id));
  const unknown = staffIds.filter((id) => !ok.has(id));
  if (unknown.length) throw Errors.validation('この店舗に所属していないスタッフが含まれています', { staffIds: unknown });
  for (const [i, id] of staffIds.entries()) {
    await ctx.trx.updateTable('staffs').set({ sort_order: i, updated_by: auditUserId(ctx.actor) }).where('id', '=', id).execute();
  }
  await audit(ctx, { action: 'staff.reorder', resourceType: 'shop', resourceId: shopId, shopId, after: { staffIds } });
  return { staffIds };
}

// ---------------------------------------------------------------- LINE通知 (new booking → staff)

interface AppointmentCreatedPayload {
  shopId: string;
  staffId: string | null;
}

const SOURCE_LABELS: Record<string, string> = {
  web: 'Web予約',
  line: 'LINE予約',
  external: '外部媒体',
  phone: '電話',
  phone_hpb: '電話（HPB）',
  walk_in: '来店',
  staff: 'スタッフ',
  next_visit: '次回予約',
  instagram: 'Instagram',
  minimo: 'minimo',
  nailie: 'ネイリー',
  referral: '友人',
  practice_model: '練習モデル',
  redo: 'お直し',
  import: '取込',
};

onEvent<AppointmentCreatedPayload & Record<string, unknown>>('appointment.created', async (ctx, event) => {
  const staffId = event.payload.staffId;
  if (!staffId) return;
  // a booking the staff member entered themself needs no notification
  if (ctx.actor.kind === 'staff' && ctx.actor.staffId === staffId) return;
  const staff = await ctx.trx.selectFrom('staffs').select(['notify_line', 'line_user_id']).where('id', '=', staffId).executeTakeFirst();
  if (!staff?.notify_line || !staff.line_user_id) return;
  await enqueue(ctx, { type: 'staff.notify_new_booking', payload: { appointmentId: event.aggregateId, staffId }, dedupeKey: `staff-notify:${event.aggregateId}` });
});

registerJob<{ appointmentId: string; staffId: string }>('staff.notify_new_booking', async (payload, jc) => {
  const prep = await jc.tx(async (ctx) => {
    const staff = await ctx.trx.selectFrom('staffs').select(['notify_line', 'line_user_id', 'status']).where('id', '=', payload.staffId).executeTakeFirst();
    if (!staff?.notify_line || !staff.line_user_id || staff.status !== 'active') return null;
    const appt = await getAppointmentUnchecked(ctx, payload.appointmentId).catch(() => null);
    if (!appt || !['tentative', 'confirmed'].includes(appt.status)) return null;
    const channel = await channelForShop(ctx, appt.shop_id);
    if (!channel) return null; // no LINE official account connected for this shop
    const shop = await getShop(ctx, appt.shop_id);
    const text = [
      '【新規予約】',
      `${formatJst(appt.start_at, 'M/d(EEE) HH:mm', shop.timezone)}〜${formatJst(appt.end_at, 'HH:mm', shop.timezone)}`,
      `お客様: ${appt.customer_name ? `${appt.customer_name} 様` : '（未登録）'}`,
      `メニュー: ${appt.services.map((m) => m.name).join('、') || '-'}`,
      `予約経路: ${SOURCE_LABELS[appt.source] ?? appt.source}`,
      appt.status === 'tentative' ? '※承認待ちの予約です' : null,
      `店舗: ${shop.name}`,
    ]
      .filter(Boolean)
      .join('\n');
    return { token: channel.accessToken(), to: staff.line_user_id, text };
  });
  if (!prep) return;
  await linePush(prep.token, prep.to, [textMessage(prep.text)], jc.job.id);
});

// ---------------------------------------------------------------- routes

export const staffScreenRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['org'];

  app.get('/shops/:id/staff-directory', { schema: { tags, summary: 'スタッフ画面の一覧(写真・ログイン状態・LINE通知・表示/非表示・担当顧客数)', params: idParam } }, (req) =>
    req.tx((ctx) => shopStaffDirectory(ctx, req.params.id)),
  );

  app.put('/staff/reorder', { schema: { tags, summary: 'スタッフの並び替え', body: z.object({ shopId: uuid, staffIds: z.array(uuid).min(1).max(500) }) } }, (req) =>
    req.tx((ctx) => reorderStaff(ctx, req.body.shopId, req.body.staffIds)),
  );

  app.put('/staff/:id/extras', { schema: { tags, summary: 'ニックネーム・プロフィール写真・LINE通知', params: idParam, body: staffExtrasSchema } }, (req) =>
    req.tx((ctx) => updateStaffExtras(ctx, req.params.id, req.body)),
  );

  app.put('/staff/:id/credentials', { schema: { tags, summary: 'ログイン情報(メールアドレス・パスワード)の設定', params: idParam, body: staffCredentialsSchema } }, (req) =>
    req.tx((ctx) => setStaffCredentials(ctx, req.params.id, req.body)),
  );
};
