import { sql } from 'kysely';
import { withSystem } from '../../../db/tenant.js';
import { registerWebhookProvider } from '../../../lib/webhooks.js';
import { parseIntegrationConfig } from '../accounts.js';
import { registerAdapter } from '../adapters/registry.js';
import { AdapterError, type BookingProviderAdapter } from '../adapters/types.js';
import {
  mailEventId,
  normalizeInboundMail,
  verifyMailgunSignature,
  type InboundMail,
} from './inbound.js';
import { applyInboundMail } from './service.js';

/**
 * E-mail ingestion connectors.
 *  hotpepper_mail: Hot Pepper Beauty bookings via SALON BOARD booking-notification mails
 *  lime_mail:      LiME bookings via LiME booking-notification mails
 *
 * Inbound (medium → Salon OS): near real time — the salon forwards notification mails to the
 *   account's inbound address; an inbound-mail service (SendGrid / Mailgun / Postmark / SES / Cloudflare)
 *   POSTs them to /v1/webhooks/inbound_email/:token. Parsed bookings go through the normal sync engine
 *   (create / change / cancel, conflict queue, double-booking protection).
 * Outbound (Salon OS → medium): neither medium has a write API, so pushMode 'manual' turns every
 *   "block this slot" into a staff task (see push.ts) instead of an API call.
 */
export const MAIL_PROVIDERS = ['hotpepper_mail', 'lime_mail'] as const;

function mailAdapter(name: string): BookingProviderAdapter {
  return {
    name,
    pushMode: 'manual',
    inboundEmail: true,
    // no polling API: bookings arrive by e-mail
    fetchChanges: async () => ({ bookings: [], nextCursor: null }),
    fetchAll: async () => ({ bookings: [], nextCursor: null }),
    pushBlock: async () => {
      throw new AdapterError(
        name,
        'この連携先には書き込みAPIがありません（手動ブロック依頼で対応）',
        true,
      );
    },
    removeBlock: async () => {
      throw new AdapterError(
        name,
        'この連携先には書き込みAPIがありません（手動ブロック依頼で対応）',
        true,
      );
    },
    health: async (account) =>
      account.config.mail?.inboundToken
        ? {
            ok: true,
            message:
              '予約通知メールの転送先が設定されています。転送設定後にテストメールで確認してください',
          }
        : { ok: false, message: '受信用アドレスが未発行です' },
  };
}

for (const name of MAIL_PROVIDERS) registerAdapter(mailAdapter(name));

const TOKEN_RE = /^[A-Za-z0-9_-]{16,100}$/;

registerWebhookProvider('inbound_email', {
  async verify(req) {
    const mail = normalizeInboundMail(req.body);
    const token = req.pathParams?.key;
    const invalid = { eventId: 'invalid', signatureValid: false };
    if (!mail || !token || !TOKEN_RE.test(token)) return invalid;
    const acc = await withSystem((trx) =>
      trx
        .selectFrom('integration_accounts')
        .select(['id', 'organization_id', 'config', 'status'])
        .where('provider', 'in', [...MAIL_PROVIDERS])
        .where(sql<string>`config->'mail'->>'inboundToken'`, '=', token)
        .executeTakeFirst(),
    );
    if (!acc || acc.status === 'disabled') return invalid;
    const signingKey = parseIntegrationConfig(acc.config).mail?.mailgunSigningKey;
    if (signingKey && !verifyMailgunSignature(req.body, signingKey)) return invalid;
    const eventId = mailEventId(acc.id, mail);
    return {
      eventId,
      eventType: 'booking_mail',
      organizationId: acc.organization_id,
      signatureValid: true,
      events: [
        { eventId, eventType: 'booking_mail', payload: { integrationAccountId: acc.id, mail } },
      ],
    };
  },
  async process(ctx, event) {
    const p = event.payload as {
      integrationAccountId: string;
      mail: InboundMail & { receivedAt: string | Date };
    };
    const result = await applyInboundMail(ctx, p.integrationAccountId, {
      ...p.mail,
      receivedAt: new Date(p.mail.receivedAt),
    });
    return result.outcome === 'ignored' ? 'ignored' : 'processed';
  },
});
