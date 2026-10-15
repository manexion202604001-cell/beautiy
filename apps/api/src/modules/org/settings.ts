/**
 * 設定 screen (owner level): shop removal, staff × shop visibility, staff invitations.
 * Shop / staff / role CRUD stays in service.ts; this file adds what the 設定 screen needs on top.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { accessibleShopIds, assertShopAccess, auditUserId, requirePermission, type Ctx } from '../../auth/actor.js';
import { invalidateActorCache } from '../../auth/load-actor.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { sendEmail, type MailMessage } from '../../lib/mailer.js';
import { idParam, uuid } from '../../lib/schemas.js';
import { countUpcomingAppointments } from '../appointments/api.js';
import { createStaff, ensurePrimaryShop, getShop, getStaff } from './service.js';

// ---------------------------------------------------------------- shop removal

/**
 * 店舗の削除. The shop row is kept (deleted_at) so past bookings, sales and kartes that refer to it
 * stay intact; it disappears from every shop list, its booking page closes and staff lose the
 * assignment. Refused for the last shop and while the shop still has bookings ahead.
 */
export async function deleteShop(ctx: Ctx, shopId: string): Promise<void> {
  requirePermission(ctx.actor, 'shop.manage', 'org.manage');
  const shop = await getShop(ctx, shopId);
  const remaining = await ctx.trx.selectFrom('shops').select('id').where('deleted_at', 'is', null).where('id', '!=', shopId).limit(1).executeTakeFirst();
  if (!remaining) throw Errors.business('LAST_SHOP', '最後の店舗は削除できません');
  const upcoming = await countUpcomingAppointments(ctx, shopId);
  if (upcoming > 0) {
    throw Errors.business('SHOP_HAS_UPCOMING_APPOINTMENTS', `この店舗には今後の予約が${upcoming}件あります。予約をキャンセルまたは変更してから削除してください`, { upcoming });
  }

  await ctx.trx
    .updateTable('shops')
    .set({ deleted_at: new Date(), status: 'closed', public_booking_enabled: false, updated_by: auditUserId(ctx.actor), trace_id: ctx.meta.traceId ?? null })
    .where('id', '=', shopId)
    .execute();

  const today = new Date().toISOString().slice(0, 10);
  const ended = await ctx.trx
    .updateTable('staff_shop_assignments')
    .set({ ended_on: sql<string>`greatest(started_on, ${today}::date)`, is_primary: false })
    .where('shop_id', '=', shopId)
    .where('ended_on', 'is', null)
    .returning('staff_id')
    .execute();
  for (const staffId of new Set(ended.map((e) => e.staff_id))) await ensurePrimaryShop(ctx, staffId);
  invalidateActorCache();

  await audit(ctx, { action: 'shop.delete', resourceType: 'shop', resourceId: shopId, shopId, before: { name: shop.name, slug: shop.slug }, metadata: { unassignedStaff: ended.length } });
}

// ---------------------------------------------------------------- staff × shop visibility

/** お客様への表示/非表示: whether the staff member appears on the shop's customer-facing booking page */
export async function setStaffShopVisibility(ctx: Ctx, staffId: string, shopId: string, visible: boolean) {
  requirePermission(ctx.actor, 'staff.manage');
  assertShopAccess(ctx.actor, shopId);
  await getStaff(ctx, staffId);
  const updated = await ctx.trx
    .updateTable('staff_shop_assignments')
    .set({ is_visible_to_customer: visible })
    .where('staff_id', '=', staffId)
    .where('shop_id', '=', shopId)
    .where('ended_on', 'is', null)
    .returning('id')
    .execute();
  if (!updated.length) throw Errors.business('NOT_ASSIGNED', 'スタッフはこの店舗に所属していません');
  await audit(ctx, { action: 'staff.shop_visibility', resourceType: 'staff', resourceId: staffId, shopId, after: { visible } });
  return getStaff(ctx, staffId);
}

// ---------------------------------------------------------------- staff invitations

/** Roles an invitation can grant from the 設定 screen (other roles are set on the staff screen) */
export const INVITE_ROLE_KEYS = ['stylist', 'manager'] as const;

export const inviteStaffSchema = z.object({
  email: z.string().trim().email('メールアドレスの形式が正しくありません'),
  displayName: z.string().trim().min(1, 'お名前を入力してください').max(100),
  roleKey: z.enum(INVITE_ROLE_KEYS),
  shopId: uuid,
});
export type InviteStaffInput = z.infer<typeof inviteStaffSchema>;

export type InvitationStatus = 'pending' | 'accepted' | 'cancelled';

export async function listInvitations(ctx: Ctx) {
  requirePermission(ctx.actor, 'staff.manage');
  const shopIds = accessibleShopIds(ctx.actor);
  let q = ctx.trx
    .selectFrom('staff_invitations as i')
    .innerJoin('staffs as s', 's.id', 'i.staff_id')
    .innerJoin('shops as sh', 'sh.id', 'i.shop_id')
    .innerJoin('roles as r', 'r.id', 'i.role_id')
    .leftJoin('staffs as inviter', 'inviter.id', 'i.invited_by_staff_id')
    .select([
      'i.id',
      'i.staff_id',
      'i.shop_id',
      'i.email',
      'i.accepted_at',
      'i.created_at',
      's.display_name as staff_name',
      's.status as staff_status',
      's.deleted_at as staff_deleted_at',
      'sh.name as shop_name',
      'r.key as role_key',
      'r.name as role_name',
      'inviter.display_name as invited_by_name',
    ])
    .orderBy('i.created_at', 'desc')
    .orderBy('i.id')
    .limit(200);
  if (shopIds) q = q.where('i.shop_id', 'in', shopIds.length ? [...shopIds] : ['00000000-0000-0000-0000-000000000000']);
  const rows = await q.execute();
  return rows.map(({ staff_status, staff_deleted_at, ...r }) => {
    const status: InvitationStatus = r.accepted_at ? 'accepted' : staff_status === 'invited' && !staff_deleted_at ? 'pending' : staff_status === 'active' && !staff_deleted_at ? 'accepted' : 'cancelled';
    return { ...r, status };
  });
}

/**
 * スタッフ招待: creates the staff member (status 'invited') assigned to the shop with the chosen
 * role, records the invitation, and returns the e-mail to send once the transaction committed.
 */
export async function inviteStaff(ctx: Ctx, input: InviteStaffInput) {
  requirePermission(ctx.actor, 'staff.manage');
  assertShopAccess(ctx.actor, input.shopId);
  const shop = await getShop(ctx, input.shopId);
  const role = await ctx.trx
    .selectFrom('roles')
    .select(['id', 'key', 'name'])
    .where('organization_id', '=', ctx.actor.organizationId)
    .where('key', '=', input.roleKey)
    .executeTakeFirst();
  if (!role) throw Errors.validation('ロールが存在しません');

  // one staff record per person in the organization
  const existing = await ctx.trx
    .selectFrom('staffs')
    .leftJoin('users', 'users.id', 'staffs.user_id')
    .select('staffs.id')
    .where('staffs.deleted_at', 'is', null)
    .where((eb) => eb.or([eb('staffs.email', '=', input.email), eb('users.email', '=', input.email)]))
    .executeTakeFirst();
  if (existing) {
    throw Errors.conflict('STAFF_EXISTS', 'このメールアドレスのスタッフは既に登録されています。下の「店舗割り当て」で店舗を設定してください', { staffId: existing.id });
  }

  const { staff, inviteUrl } = await createStaff(ctx, { displayName: input.displayName, email: input.email, roleId: role.id, shopIds: [input.shopId] });
  if (!inviteUrl) throw Errors.system('招待リンクを作成できませんでした');
  const invitation = await ctx.trx
    .insertInto('staff_invitations')
    .values({
      organization_id: ctx.actor.organizationId,
      staff_id: staff.id,
      shop_id: input.shopId,
      role_id: role.id,
      email: input.email,
      invited_by_staff_id: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .returning(['id', 'created_at'])
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'staff.invite', resourceType: 'staff', resourceId: staff.id, shopId: input.shopId, after: { email: input.email, role: role.key } });

  const org = await ctx.trx.selectFrom('organizations').select('name').where('id', '=', ctx.actor.organizationId).executeTakeFirstOrThrow();
  const inviter = ctx.actor.kind === 'staff' ? ctx.actor.displayName : null;
  const mail: MailMessage = {
    to: input.email,
    subject: `【Salon OS】${org.name} からスタッフ招待が届いています`,
    text: [
      `${input.displayName} 様`,
      '',
      `${inviter ? `${inviter} さんから` : ''}「${shop.name}」のスタッフ（${role.name}）として招待されました。`,
      '以下のリンクを開き、パスワードを設定して参加してください（有効期限: 7日）。',
      inviteUrl,
      '',
      'このメールに心当たりがない場合は破棄してください。',
    ].join('\n'),
  };
  return { invitationId: invitation.id, staffId: staff.id, inviteUrl, mail };
}

// ---------------------------------------------------------------- routes

export const settingsRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['org'];

  app.delete('/shops/:id', { schema: { tags, summary: '店舗削除(一覧・予約受付から外す)', params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => deleteShop(ctx, req.params.id));
    return reply.status(204).send();
  });

  app.put(
    '/staff/:id/shops/:shopId/visibility',
    { schema: { tags, summary: 'お客様への表示/非表示(店舗ごと)', params: z.object({ id: uuid, shopId: uuid }), body: z.object({ visible: z.boolean() }) } },
    (req) => req.tx((ctx) => setStaffShopVisibility(ctx, req.params.id, req.params.shopId, req.body.visible)),
  );

  app.get('/staff-invitations', { schema: { tags, summary: '招待履歴' } }, (req) => req.tx((ctx) => listInvitations(ctx)));

  app.post('/staff-invitations', { schema: { tags, summary: 'スタッフ招待(メール送信)', body: inviteStaffSchema } }, async (req, reply) => {
    const { mail, ...result } = await req.tx((ctx) => inviteStaff(ctx, req.body));
    // sent after the commit: a mail failure must not undo the invitation (the link is returned either way)
    let emailSent = true;
    try {
      await sendEmail(mail);
    } catch (err) {
      emailSent = false;
      req.log.error({ err }, 'staff invitation mail failed');
    }
    return reply.status(201).send({ ...result, emailSent });
  });
};
