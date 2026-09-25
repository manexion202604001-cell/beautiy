// Inbound external booking webhook: POST /api/webhooks/booking/<webhookKey>
// Signature is verified against the integration's webhook secret; events are stored
// idempotently (provider + event id) and processed inline, then retried by cron.
import { NextResponse } from 'next/server';
import { ingestBookingWebhook } from '@/lib/server/sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > 256 * 1024) return NextResponse.json({ ok: false, error: 'payload_too_large' }, { status: 413 });
  const raw = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  try {
    const r = await ingestBookingWebhook(key, headers, raw);
    return NextResponse.json(r.body, { status: r.status });
  } catch (e) {
    console.error('[webhook:booking] error', e);
    // 500 → the provider retries; the event (if stored) is also retried by cron.
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: false, error: 'method_not_allowed' }, { status: 405, headers: { Allow: 'POST' } });
}
