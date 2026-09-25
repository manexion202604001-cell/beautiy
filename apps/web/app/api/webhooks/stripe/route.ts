import { NextRequest, NextResponse } from 'next/server';
import { handlePaymentWebhook } from '@/lib/server/payments/webhooks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// STRIPE webhook: raw body is required for signature verification. Optional ?k=<Integration.webhookKey>
// selects an organization's own signing secret; otherwise the env secret is used.
export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > 1_000_000) return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  const r = await handlePaymentWebhook('STRIPE', raw, req.headers, new URL(req.url));
  return NextResponse.json(r.body, { status: r.status });
}
