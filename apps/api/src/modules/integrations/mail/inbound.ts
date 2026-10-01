import { hmacSha256, safeEqual, sha256 } from '../../../lib/crypto.js';

/**
 * Normalize inbound-e-mail webhook payloads from common providers into one shape.
 * Supported: canonical JSON {from,to,subject,text,html,messageId,date} (e.g. Cloudflare Email Workers,
 * Amazon SES via Lambda), Postmark (JSON), Mailgun routes (form fields), SendGrid Inbound Parse (multipart).
 */
export interface InboundMail {
  from: string;
  to: string;
  subject: string;
  text: string | null;
  html: string | null;
  messageId: string | null;
  receivedAt: Date;
}

type Fields = Record<string, unknown>;
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length
    ? v
    : Array.isArray(v) && typeof v[0] === 'string'
      ? v[0]
      : null;

function headerValue(rawHeaders: string | null, name: string): string | null {
  if (!rawHeaders) return null;
  const m = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(rawHeaders);
  return m ? m[1]!.trim() : null;
}

function parseDate(v: string | null): Date | null {
  if (!v) return null;
  const n = /^\d{9,11}$/.test(v) ? Number(v) * 1000 : Date.parse(v);
  return Number.isFinite(n) ? new Date(n) : null;
}

/** strip forwarding prefixes added by the salon's mail client ("Fwd:", "転送:", "FW:") */
export function cleanSubject(subject: string): string {
  let s = subject.trim();
  for (let i = 0; i < 5; i++) {
    const next = s.replace(/^\s*(fwd?|fw|転送|re)\s*[:：]\s*/i, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

export function normalizeInboundMail(body: unknown, now = new Date()): InboundMail | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Fields;
  const rawHeaders = str(b.headers) ?? str(b['message-headers']);
  const subject = str(b.subject) ?? str(b.Subject) ?? headerValue(rawHeaders, 'Subject');
  const text =
    str(b.text) ?? str(b.TextBody) ?? str(b['body-plain']) ?? str(b['stripped-text']) ?? null;
  const html = str(b.html) ?? str(b.HtmlBody) ?? str(b['body-html']) ?? null;
  if (!subject && !text && !html) return null;
  const messageId =
    str(b.messageId) ??
    str(b.MessageID) ??
    str(b['Message-Id']) ??
    str(b['message-id']) ??
    headerValue(rawHeaders, 'Message-ID') ??
    null;
  const receivedAt =
    parseDate(str(b.date) ?? str(b.Date) ?? str(b.timestamp) ?? headerValue(rawHeaders, 'Date')) ??
    now;
  return {
    from: str(b.from) ?? str(b.From) ?? str(b.sender) ?? '',
    to: str(b.to) ?? str(b.To) ?? str(b.recipient) ?? '',
    subject: cleanSubject(subject ?? ''),
    text,
    html,
    messageId,
    receivedAt,
  };
}

export function mailEventId(accountId: string, mail: InboundMail): string {
  return `${accountId}:${mail.messageId ? mail.messageId.slice(0, 200) : sha256(`${mail.subject}\n${mail.text ?? mail.html ?? ''}`)}`;
}

/** Mailgun webhook signature: hex HMAC-SHA256(timestamp + token, signingKey) */
export function verifyMailgunSignature(body: unknown, signingKey: string): boolean {
  const b = (body ?? {}) as Fields;
  const timestamp = str(b.timestamp);
  const token = str(b.token);
  const signature = str(b.signature);
  if (!timestamp || !token || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 15 * 60) return false;
  return safeEqual(hmacSha256(signingKey, timestamp + token), signature);
}
