// Google Business Profile (GBP) review synchronization adapter.
//
// Required setup (production):
//  - Google Cloud project with "My Business Account Management API" and
//    "My Business Business Information API" enabled, plus access to the legacy
//    `mybusiness.googleapis.com/v4` reviews endpoints (granted per project by Google).
//  - OAuth 2.0 consent with scope `https://www.googleapis.com/auth/business.manage`
//    (offline access → refresh token).
//  - Integration row: provider 'GOOGLE', shopId = the salon shop, configEnc:
//      { accessToken, refreshToken?, clientId?, clientSecret?, accountId, locationId }
// Without that configuration the sandbox adapter is used: it returns no reviews and
// accepts replies as no-ops, so the UI and sync flow work in development.
import { getIntegration } from '../integrations';

export const GOOGLE_BUSINESS_SCOPES = ['https://www.googleapis.com/auth/business.manage'] as const;

export interface NormalizedExternalReview {
  externalRef: string;
  rating: number;
  authorName: string;
  body: string | null;
  createdAt: Date;
  reply: string | null;
  repliedAt: Date | null;
}

export interface ReviewSourceAdapter {
  readonly name: string;
  readonly sandbox: boolean;
  listReviews(since?: Date | null): Promise<NormalizedExternalReview[]>;
  replyToReview(externalRef: string, text: string): Promise<{ ok: boolean; error?: string }>;
}

const STAR: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

/** Normalize one GBP v4 review payload (pure; exported for tests). */
export function normalizeGoogleReview(r: any): NormalizedExternalReview | null {
  const rating = STAR[String(r?.starRating)] ?? 0;
  if (!r?.reviewId || !rating) return null;
  return {
    externalRef: `google:${r.reviewId}`,
    rating,
    authorName: r.reviewer?.isAnonymous ? 'Googleユーザー' : String(r.reviewer?.displayName ?? 'Googleユーザー').slice(0, 60),
    body: r.comment ? String(r.comment).slice(0, 4000) : null,
    createdAt: new Date(r.createTime ?? Date.now()),
    reply: r.reviewReply?.comment ?? null,
    repliedAt: r.reviewReply?.updateTime ? new Date(r.reviewReply.updateTime) : null,
  };
}

class SandboxGoogleAdapter implements ReviewSourceAdapter {
  readonly name = 'google-sandbox';
  readonly sandbox = true;
  async listReviews() { return []; }
  async replyToReview() { return { ok: true }; }
}

class GoogleBusinessAdapter implements ReviewSourceAdapter {
  readonly name = 'google-business-profile';
  readonly sandbox = false;
  constructor(private cfg: { accessToken: string; accountId: string; locationId: string }) {}
  private base() { return `https://mybusiness.googleapis.com/v4/accounts/${encodeURIComponent(this.cfg.accountId)}/locations/${encodeURIComponent(this.cfg.locationId)}`; }
  async listReviews(since?: Date | null) {
    const out: NormalizedExternalReview[] = [];
    let pageToken = '';
    for (let page = 0; page < 10; page++) {
      const url = `${this.base()}/reviews?pageSize=50&orderBy=updateTime%20desc${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${this.cfg.accessToken}` }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      let stop = false;
      for (const r of j.reviews ?? []) {
        const n = normalizeGoogleReview(r);
        if (!n) continue;
        if (since && new Date(r.updateTime ?? r.createTime) < since) { stop = true; break; }
        out.push(n);
      }
      pageToken = j.nextPageToken ?? '';
      if (stop || !pageToken) break;
    }
    return out;
  }
  async replyToReview(externalRef: string, text: string) {
    const id = externalRef.replace(/^google:/, '');
    try {
      const res = await fetch(`${this.base()}/reviews/${encodeURIComponent(id)}/reply`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.accessToken}` },
        body: JSON.stringify({ comment: text }), signal: AbortSignal.timeout(10000),
      });
      return res.ok ? { ok: true } : { ok: false, error: `Google API ${res.status}` };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }
}

export async function googleReviewAdapter(orgId: string, shopId: string): Promise<{ adapter: ReviewSourceAdapter; integrationId: string | null }> {
  const it = await getIntegration(orgId, 'GOOGLE', shopId);
  const c = it?.config ?? {};
  if (it && it.integration.status !== 'PAUSED' && c.accessToken && c.accountId && c.locationId) {
    return { adapter: new GoogleBusinessAdapter({ accessToken: c.accessToken, accountId: c.accountId, locationId: c.locationId }), integrationId: it.integration.id };
  }
  return { adapter: new SandboxGoogleAdapter(), integrationId: it?.integration.id ?? null };
}
