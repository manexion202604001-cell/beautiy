// LINE Messaging API webhook. Path key = Integration.webhookKey (identifies org/shop).
// verify x-line-signature → store each event in WebhookEvent (unique provider+eventId)
// → respond 200 immediately → process after the response (next/server `after`).
import { NextRequest, NextResponse, after } from 'next/server';
import { normalizeLineWebhook, verifyLineSignature } from '@salonos/core/integrations/line';
import { findLineIntegrationByKey, lineChannelSecret, processRecordedLineEvents, recordLineEvents } from '@/lib/server/line';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  // Unknown or PAUSED integration → 404 (a paused salon receives nothing).
  const integration = await findLineIntegrationByKey(key);
  if (!integration || integration.status === 'PAUSED') return NextResponse.json({ error: 'not found' }, { status: 404 });

  const raw = await req.text();
  const secret = lineChannelSecret(integration);
  if (!secret || !verifyLineSignature(req.headers.get('x-line-signature'), raw, secret)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  let events;
  try {
    events = normalizeLineWebhook(raw);
  } catch {
    return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
  }
  // LINE sends an empty events array when verifying the webhook URL.
  if (!events.length) return NextResponse.json({ ok: true, received: 0 });

  const { fresh, duplicates } = await recordLineEvents(integration.organizationId, integration, events);
  if (fresh.length) {
    after(async () => {
      try {
        await processRecordedLineEvents(integration, fresh);
      } catch (e) {
        // rows stay RECEIVED and are retried by /api/cron
        console.error('[line-webhook] deferred processing failed', e);
      }
    });
  }
  return NextResponse.json({ ok: true, received: events.length, duplicates });
}

export function GET() {
  return NextResponse.json({ ok: true, hint: 'LINE webhook endpoint (POST only)' });
}
