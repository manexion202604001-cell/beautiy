// Instagram booking-entry adapter.
// Instagram offers no booking API for salons; the entry points are links placed in the
// profile (link in bio), story link stickers and the "Book" action button (which accepts a
// URL). These helpers generate attributed URLs so bookings arriving via Instagram are
// recorded with source=INSTAGRAM by the public booking flow (`?src=instagram`).
// Future: Instagram Graph API (scopes instagram_basic, pages_show_list) could import the
// profile's recent media for the public profile page.
import { env } from '../env';

export type InstagramPlacement = 'bio' | 'story' | 'action_button' | 'post';

function withParams(path: string, params: Record<string, string | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return `${env.appUrl}${path}${s ? `?${s}` : ''}`;
}

/** Direct link into the public booking flow, attributed to Instagram. */
export function instagramBookingLink(shopSlug: string, opts: { staffUserId?: string; placement?: InstagramPlacement } = {}) {
  return withParams(`/book/${shopSlug}`, { src: 'instagram', staff: opts.staffUserId, utm_medium: opts.placement });
}

/** Link-in-bio URL: the public shop (or stylist) profile with a big booking CTA. */
export function instagramProfileLink(shopSlug: string, membershipId?: string) {
  return withParams(membershipId ? `/s/${shopSlug}/staff/${membershipId}` : `/s/${shopSlug}`, { src: 'instagram' });
}

/** Normalize a user-entered Instagram handle or URL to https://www.instagram.com/<handle>/ (null if invalid). */
export function normalizeInstagramUrl(input: string | null | undefined): string | null {
  const s = (input ?? '').trim();
  if (!s) return null;
  const m = /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/.exec(s) ?? /^@?([A-Za-z0-9._]{1,30})$/.exec(s);
  return m ? `https://www.instagram.com/${m[1]}/` : null;
}
