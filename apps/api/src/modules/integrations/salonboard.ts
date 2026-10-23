/**
 * 予約詳細「サロンボードに連携 / 再同期 / 連携を再試行」(SALOGIC syncToSalonboard).
 * Salon OS blocks a booking taken elsewhere on SALON BOARD through the shop's hotpepper_mail
 * connector (a 予定 added by the 自動枠止め helper, or a staff task when the helper is off). The
 * button asks for that again: it is idempotent and only re-opens a request the helper has nothing on
 * record for; the push job (push.ts) does the rest.
 */
import { hasShopAccess, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { ACTIVE_STATUSES } from '../appointments/service.js';
import { parseIntegrationConfig } from './accounts.js';
import { AGENT_ERROR_PREFIX, appointmentMediaSync } from './api.js';
import { enqueuePushJob } from './push.js';

function hasHelperRecord(v: string | null): boolean {
  if (!v || !v.startsWith('{')) return false;
  try {
    const rec = JSON.parse(v) as { staffId?: unknown };
    return typeof rec.staffId === 'string';
  } catch {
    return false;
  }
}

export async function syncAppointmentToSalonboard(ctx: Ctx, appointmentId: string) {
  requirePermission(ctx.actor, 'appointment.write');
  const appt = await ctx.trx
    .selectFrom('appointments')
    .select(['id', 'shop_id', 'status', 'source', 'source_detail'])
    .where('id', '=', appointmentId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!appt || !hasShopAccess(ctx.actor, appt.shop_id))
    throw Errors.notFound('予約', appointmentId);
  const acc = await ctx.trx
    .selectFrom('integration_accounts')
    .select(['id', 'shop_id', 'config'])
    .where('shop_id', '=', appt.shop_id)
    .where('provider', '=', 'hotpepper_mail')
    .where('status', '!=', 'disabled')
    .executeTakeFirst();
  if (!acc)
    throw Errors.business(
      'SALONBOARD_NOT_CONNECTED',
      'この店舗にはサロンボード（ホットペッパー）の連携がありません。外部連携で追加してください',
    );
  const cfg = parseIntegrationConfig(acc.config);
  if (!cfg.pushBlocks)
    throw Errors.business(
      'SALONBOARD_DISABLED',
      'サロンボード連携が有効になっていません（店舗設定 › サロンボード）',
    );
  const fromHpb = await ctx.trx
    .selectFrom('external_bookings')
    .select('id')
    .where('integration_account_id', '=', acc.id)
    .where('appointment_id', '=', appt.id)
    .executeTakeFirst();
  if (fromHpb)
    throw Errors.business(
      'SALONBOARD_ORIGIN',
      'ホットペッパーの予約はサロンボードに登録されています',
    );
  const migrated =
    appt.source === 'import' || !!(appt.source_detail as { migrated?: boolean } | null)?.migrated;
  if (migrated)
    throw Errors.business(
      'SALONBOARD_MIGRATED',
      '以前のシステムから移した予約はサロンボードに登録されています',
    );
  if (!(ACTIVE_STATUSES as readonly string[]).includes(appt.status))
    throw Errors.business(
      'APPOINTMENT_NOT_ACTIVE',
      'この予約はサロンボードに連携できません（キャンセル済み・完了など）',
    );

  const block = await ctx.trx
    .selectFrom('external_slot_blocks')
    .select(['id', 'state', 'manual', 'external_block_id', 'last_error'])
    .where('integration_account_id', '=', acc.id)
    .where('appointment_id', '=', appt.id)
    .forUpdate()
    .executeTakeFirst();
  const auto = !!cfg.mail?.agentManaged;
  let reopened = false;
  if (auto && block?.manual) {
    if (block.state === 'pushed' && !hasHelperRecord(block.external_block_id)) {
      // settled without a 予定 on SALON BOARD (skipped, or marked done by hand): let the helper look again
      await ctx.trx
        .updateTable('external_slot_blocks')
        .set({
          state: 'action_required',
          last_error: 'サロンボードへの連携を依頼しました',
          notified_at: new Date(),
          done_at: null,
          done_by: null,
        })
        .where('id', '=', block.id)
        .execute();
      reopened = true;
    } else if (
      block.state === 'action_required' &&
      block.last_error?.startsWith(AGENT_ERROR_PREFIX)
    ) {
      // the helper failed last time; it tries again on its next run
      await ctx.trx
        .updateTable('external_slot_blocks')
        .set({ last_error: 'サロンボードへの連携を再試行します' })
        .where('id', '=', block.id)
        .execute();
      reopened = true;
    }
  }
  await enqueuePushJob(ctx, acc.id, appt.id, `sb-sync-${Date.now()}`);
  await audit(ctx, {
    action: 'integration.salonboard_sync',
    resourceType: 'appointment',
    resourceId: appt.id,
    shopId: appt.shop_id,
    metadata: { integrationAccountId: acc.id, previousState: block?.state ?? null, reopened },
  });
  const media = await appointmentMediaSync(ctx, [appt.id]);
  return { salonboard: media.get(appt.id)?.salonboard ?? null };
}
