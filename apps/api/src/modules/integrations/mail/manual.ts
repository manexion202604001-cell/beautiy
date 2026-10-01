import type { JobContext } from '../../../jobs/queue.js';
import { sendEmail } from '../../../lib/mailer.js';
import { formatJst } from '../../../lib/time.js';
import { parseIntegrationConfig, type AccountRow } from '../accounts.js';
import { PROVIDER_PROFILES } from './parser.js';

interface ApptRow {
  id: string;
  shop_id: string;
  staff_id: string | null;
  occupied_start_at: Date;
  occupied_end_at: Date;
}
interface BlockRow {
  state: string;
  block_start_at: Date | null;
  block_end_at: Date | null;
}

const fmt = (d: Date | null) => (d ? formatJst(d, 'M/d(EEE) HH:mm') : '-');

/**
 * Convergent manual reconciliation for media without a write API.
 *  want & nothing blocked yet         → action_required ("block this slot on <medium>")
 *  want & blocked at different times  → action_required (move the block)
 *  want & remove_required, same times → pushed (booking restored before staff reopened it)
 *  !want & action_required            → removed (task no longer needed)
 *  !want & pushed                     → remove_required ("reopen this slot on <medium>")
 * Staff close tasks with POST /integrations/manual-blocks/:id/done.
 */
export async function reconcileManualBlock(
  jc: JobContext,
  acc: AccountRow,
  appt: ApptRow,
  block: BlockRow | undefined,
  want: boolean,
): Promise<void> {
  const sameTimes =
    !!block &&
    block.block_start_at?.getTime() === appt.occupied_start_at.getTime() &&
    block.block_end_at?.getTime() === appt.occupied_end_at.getTime();
  const state = block?.state;
  let next: { state: string; message: string | null; times: boolean } | null = null;

  if (want) {
    if (state === 'pushed' && sameTimes) return;
    if (state === 'remove_required' && sameTimes)
      next = { state: 'pushed', message: null, times: false };
    else if (state === 'action_required' && sameTimes) return;
    else if (state === 'pushed' || state === 'remove_required') {
      next = {
        state: 'action_required',
        message: `予約時間が変更されました。旧枠（${fmt(block!.block_start_at)}〜）を再開し、新しい枠を止めてください`,
        times: true,
      };
    } else
      next = {
        state: 'action_required',
        message: '他の経路で予約が入りました。この枠を止めてください',
        times: true,
      };
  } else {
    if (state === 'action_required') next = { state: 'removed', message: null, times: false };
    else if (state === 'pushed')
      next = {
        state: 'remove_required',
        message: '予約が取り消されました。止めていた枠を再開してください',
        times: false,
      };
    else return;
  }

  const notify = next.state === 'action_required' || next.state === 'remove_required';
  const info = await jc.tx(async (ctx) => {
    const patch = {
      state: next!.state,
      manual: true,
      last_error: next!.message,
      ...(next!.times
        ? { block_start_at: appt.occupied_start_at, block_end_at: appt.occupied_end_at }
        : {}),
      ...(notify ? { notified_at: new Date(), done_at: null, done_by: null } : {}),
    };
    await ctx.trx
      .insertInto('external_slot_blocks')
      .values({
        organization_id: ctx.actor.organizationId,
        integration_account_id: acc.id,
        appointment_id: appt.id,
        ...patch,
      })
      .onConflict((oc) =>
        oc.columns(['integration_account_id', 'appointment_id']).doUpdateSet(patch),
      )
      .execute();
    if (!notify) return null;
    const [shop, staff] = await Promise.all([
      ctx.trx
        .selectFrom('shops')
        .select(['name', 'email'])
        .where('id', '=', appt.shop_id)
        .executeTakeFirst(),
      appt.staff_id
        ? ctx.trx
            .selectFrom('staffs')
            .select('display_name')
            .where('id', '=', appt.staff_id)
            .executeTakeFirst()
        : undefined,
    ]);
    return { shop, staffName: staff?.display_name ?? '指名なし' };
  });
  if (!info) return;

  const recipients = parseIntegrationConfig(acc.config).mail?.notifyEmails?.length
    ? parseIntegrationConfig(acc.config).mail!.notifyEmails!
    : info.shop?.email
      ? [info.shop.email]
      : [];
  const medium = PROVIDER_PROFILES[acc.provider]?.label ?? acc.display_name;
  const action = next.state === 'action_required' ? '枠を止めてください' : '枠を再開してください';
  for (const to of recipients) {
    await sendEmail({
      to,
      subject: `【要対応】${medium}: ${fmt(appt.occupied_start_at)} ${info.staffName} の${action}`,
      text: [
        `${info.shop?.name ?? ''}`,
        '',
        next.message ?? '',
        '',
        `連携先: ${medium}`,
        `日時: ${fmt(appt.occupied_start_at)} 〜 ${formatJst(appt.occupied_end_at, 'HH:mm')}`,
        `担当: ${info.staffName}`,
        '',
        '対応後、Salon OS の「外部連携 → 手動ブロック依頼」で「対応済み」にしてください。',
      ].join('\n'),
    });
  }
}
