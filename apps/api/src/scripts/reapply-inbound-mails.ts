/**
 * Apply the booking-notification mails received since a date again, oldest first — after the mail
 * parser was improved, so mails that ended in a conflict ("メニュー不明" …) are taken in properly.
 * Safe to repeat: a mail whose parsed booking did not change is skipped, and a later mail about the
 * same booking (change / cancellation) is applied after the earlier one, as when it arrived.
 *
 *   pnpm --filter @salon/api exec tsx src/scripts/reapply-inbound-mails.ts --since 2026-10-19
 */
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { systemActor } from '../auth/actor.js';
import { db } from '../db/client.js';
import { withSystem, withTenant } from '../db/tenant.js';
import '../modules/index.js';
import type { InboundMail } from '../modules/integrations/mail/inbound.js';
import { applyInboundMail } from '../modules/integrations/mail/service.js';

const { values: args } = parseArgs({ options: { since: { type: 'string' }, rematch: { type: 'boolean' } } });
if (!args.since || !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) {
  console.error('usage: reapply-inbound-mails.ts --since YYYY-MM-DD');
  process.exit(1);
}

async function main() {
  const events = await withSystem((trx) =>
    trx
      .selectFrom('webhook_events')
      .select(['id', 'organization_id', 'payload', 'received_at'])
      .where('provider', '=', 'inbound_email')
      .where('signature_valid', '=', true)
      .where('received_at', '>=', new Date(`${args.since}T00:00:00+09:00`))
      .orderBy('received_at')
      .execute(),
  );
  if (args.rematch) {
    // the parsed booking may be unchanged while the menu matching improved: apply them all again
    await withSystem((trx) =>
      trx
        .updateTable('external_bookings')
        .set({ payload_hash: '' })
        .where(sql<string>`raw_payload->>'source'`, '=', 'email')
        .where('created_at', '>=', new Date(`${args.since}T00:00:00+09:00`))
        .execute(),
    );
  }
  const outcomes: Record<string, number> = {};
  const failures: string[] = [];
  for (const ev of events) {
    const p = ev.payload as { integrationAccountId?: string; mail?: InboundMail & { receivedAt: string } };
    if (!ev.organization_id || !p.integrationAccountId || !p.mail) continue;
    try {
      const result = await withTenant(ev.organization_id, (trx) =>
        applyInboundMail({ actor: systemActor(ev.organization_id!, 'mail-reapply'), trx, meta: { traceId: 'mail-reapply' } }, p.integrationAccountId!, {
          ...p.mail!,
          receivedAt: new Date(p.mail!.receivedAt),
        }),
      );
      outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
      await withSystem((trx) =>
        trx
          .updateTable('webhook_events')
          .set({ status: result.outcome === 'ignored' ? 'ignored' : 'processed', last_error: null, processed_at: new Date() })
          .where('id', '=', ev.id)
          .execute(),
      );
    } catch (e) {
      outcomes.error = (outcomes.error ?? 0) + 1;
      failures.push(`${p.mail.subject}: ${(e as Error).message}`);
    }
  }
  // conflicts left open by the earlier parse whose booking is now taken in
  const closed = await withSystem((trx) =>
    trx
      .updateTable('sync_conflicts')
      .set({ state: 'resolved', resolution: 'manual', resolved_at: new Date() })
      .where('state', '=', 'open')
      .where('conflict_type', 'in', ['unknown_menu', 'unknown_staff'])
      .where(sql<boolean>`exists (select 1 from external_bookings eb where eb.id = sync_conflicts.external_booking_id and eb.sync_state = 'synced')`)
      .executeTakeFirst(),
  );
  console.log(JSON.stringify({ mails: events.length, outcomes, conflictsClosed: Number(closed.numUpdatedRows), failures }, null, 1));
}

main()
  .then(() => db.destroy())
  .catch(async (e) => {
    console.error(e);
    await db.destroy();
    process.exit(1);
  });
