/**
 * サロンボード スタッフ名 / スタッフID (スタッフ編集, as in SALOGIC).
 * The name is the stylist's name on SALON BOARD; it is also the key of the shop's hotpepper_mail
 * connector staffMap (booking mails name the stylist that way), so saving it keeps that map in step:
 * the new name points to the stylist, the previous name is dropped.
 */
import { auditUserId, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { integrationConfigSchema } from '../integrations/schemas.js';

const HOTPEPPER = 'hotpepper_mail';

/** '' means "not set" */
export const blankToNull = (v: string | null | undefined) =>
  v === undefined ? undefined : v && v.trim() ? v.trim() : null;

/** another stylist of the same shops already uses this SALON BOARD name / id */
export async function assertSalonboardUnique(
  ctx: Ctx,
  staffId: string,
  input: { name?: string | null; staffId?: string | null },
) {
  const checks = [
    ['salonboard_name', input.name, 'このサロンボード スタッフ名は他のスタッフに設定されています'],
    [
      'salonboard_staff_id',
      input.staffId,
      'このサロンボード スタッフIDは他のスタッフに設定されています',
    ],
  ] as const;
  for (const [column, value, message] of checks) {
    if (!value) continue;
    const other = await ctx.trx
      .selectFrom('staffs as s')
      .innerJoin('staff_shop_assignments as a', 'a.staff_id', 's.id')
      .innerJoin('staff_shop_assignments as mine', 'mine.shop_id', 'a.shop_id')
      .select('s.id')
      .where('mine.staff_id', '=', staffId)
      .where('mine.ended_on', 'is', null)
      .where('a.ended_on', 'is', null)
      .where('s.id', '!=', staffId)
      .where('s.deleted_at', 'is', null)
      .where(`s.${column}`, '=', value)
      .executeTakeFirst();
    if (other) throw Errors.validation(message, { staffId: other.id });
  }
}

/** staffMap of the stylist's shops' SALON BOARD connectors: drop `previous`, map `next` to the stylist */
export async function syncSalonboardStaffMap(
  ctx: Ctx,
  staffId: string,
  previous: string | null,
  next: string | null,
) {
  if (previous === next) return;
  const accounts = await ctx.trx
    .selectFrom('integration_accounts as ia')
    .innerJoin('staff_shop_assignments as a', 'a.shop_id', 'ia.shop_id')
    .select(['ia.id', 'ia.shop_id', 'ia.config'])
    .where('a.staff_id', '=', staffId)
    .where('a.ended_on', 'is', null)
    .where('ia.provider', '=', HOTPEPPER)
    .execute();
  for (const acc of accounts) {
    const parsed = integrationConfigSchema.safeParse(acc.config ?? {});
    if (!parsed.success) continue;
    const cfg = parsed.data;
    const staffMap = { ...cfg.staffMap };
    if (previous && staffMap[previous] === staffId) delete staffMap[previous];
    if (next) staffMap[next] = staffId;
    if (JSON.stringify(staffMap) === JSON.stringify(cfg.staffMap)) continue;
    await ctx.trx
      .updateTable('integration_accounts')
      .set({ config: JSON.stringify({ ...cfg, staffMap }) })
      .where('id', '=', acc.id)
      .execute();
    await audit(ctx, {
      action: 'integration.update',
      resourceType: 'integration_account',
      resourceId: acc.id,
      shopId: acc.shop_id,
      before: { staffMap: cfg.staffMap },
      after: { staffMap },
      metadata: { reason: 'staff.salonboard_name', staffId, by: auditUserId(ctx.actor) },
    });
  }
}
