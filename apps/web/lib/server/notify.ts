// Outbound customer messaging with channel selection + delivery log.
// Channels: LINE (Messaging API push) and EMAIL (Resend HTTP API). When provider
// credentials are absent the message is recorded as delivered in sandbox mode.
import type { MessageChannel } from '@salonos/db';
import { prisma } from './db';
import { decryptField } from './pii';
import { getIntegration } from './integrations';
import { env } from './env';

export interface SendInput {
  orgId: string;
  shopId?: string | null;
  customerId: string;
  body: string;
  channel?: MessageChannel;
  appointmentId?: string;
  templateId?: string;
  broadcastId?: string;
  automationRuleId?: string;
  createdById?: string;
  subject?: string;
}

export interface ProviderResult { ok: boolean; externalId?: string; error?: string; sandbox?: boolean }

export async function linePush(orgId: string, shopId: string | null | undefined, to: string, text: string): Promise<ProviderResult> {
  const it = await getIntegration(orgId, 'LINE', shopId);
  // Env token only when there is no row or the row has no LINE credentials of its own (see line.ts usesEnvChannel).
  const token: string = it?.config.channelAccessToken || (!it?.config.channelSecret ? env.line.accessToken : '');
  if (!token || it?.integration.status === 'PAUSED') return { ok: true, sandbox: true, externalId: `sandbox-line-${Date.now()}` };
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages: [{ type: 'text', text: text.slice(0, 5000) }] }),
    });
    if (!res.ok) return { ok: false, error: `LINE API ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const reqId = res.headers.get('x-line-request-id') ?? undefined;
    return { ok: true, externalId: reqId };
  } catch (e: any) {
    return { ok: false, error: `LINE API network error: ${e?.message ?? e}` };
  }
}

export async function sendEmail(to: string, subject: string, text: string): Promise<ProviderResult> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? 'MANEXION Salon <no-reply@example.com>';
  if (!key) { console.info(`[email:sandbox] to=${to} subject=${subject}`); return { ok: true, sandbox: true, externalId: `sandbox-mail-${Date.now()}` }; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from, to, subject, text }),
    });
    if (!res.ok) return { ok: false, error: `Email API ${res.status}` };
    const j = await res.json().catch(() => ({}));
    return { ok: true, externalId: j.id };
  } catch (e: any) {
    return { ok: false, error: `Email network error: ${e?.message ?? e}` };
  }
}

/** Pick the channel a customer can actually receive on (respecting opt-outs). */
export async function resolveChannel(orgId: string, customerId: string, preferred?: MessageChannel) {
  const c = await prisma.customer.findFirst({
    where: { id: customerId, organizationId: orgId },
    include: { identities: { where: { provider: 'LINE' } } },
  });
  if (!c) return null;
  const lineId = c.identities[0]?.externalId ?? null;
  const email = decryptField(c.emailEnc);
  const lineOk = !!lineId && c.lineOptIn;
  const emailOk = !!email && c.emailOptIn;
  let channel: MessageChannel | null = null;
  if (preferred === 'LINE') channel = lineOk ? 'LINE' : null;
  else if (preferred === 'EMAIL') channel = emailOk ? 'EMAIL' : null;
  else channel = lineOk ? 'LINE' : emailOk ? 'EMAIL' : null;
  return { customer: c, channel, lineId, email };
}

export async function sendCustomerMessage(input: SendInput) {
  const r = await resolveChannel(input.orgId, input.customerId, input.channel);
  if (!r) throw new Error('customer not found');
  const base = {
    organizationId: input.orgId, shopId: input.shopId ?? null, customerId: input.customerId, body: input.body,
    direction: 'OUTBOUND' as const, templateId: input.templateId, broadcastId: input.broadcastId,
    automationRuleId: input.automationRuleId, appointmentId: input.appointmentId, createdById: input.createdById,
  };
  if (!r.channel) {
    return prisma.message.create({ data: { ...base, channel: input.channel ?? 'LINE', status: 'SKIPPED', error: '送信可能な連絡先がない、または配信停止中です' } });
  }
  const msg = await prisma.message.create({ data: { ...base, channel: r.channel, status: 'QUEUED' } });
  const res = r.channel === 'LINE'
    ? await linePush(input.orgId, input.shopId, r.lineId!, input.body)
    : await sendEmail(r.email!, input.subject ?? 'サロンからのお知らせ', input.body);
  return prisma.message.update({
    where: { id: msg.id },
    data: res.ok
      ? { status: 'SENT', sentAt: new Date(), externalMessageId: res.externalId ?? null, error: res.sandbox ? 'sandbox' : null }
      : { status: 'FAILED', error: res.error ?? 'unknown error' },
  });
}
