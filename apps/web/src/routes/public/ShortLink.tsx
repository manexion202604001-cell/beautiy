import { Navigate, useLocation, useParams } from 'react-router';

/**
 * /s/:shopSlug[/*] — short shop links used in message templates ({{shop.bookingUrl}}) and referral
 * targets. Redirects to the booking page, keeping query params (ref, utm_*):
 *   /s/:slug              → /book/:slug
 *   /s/:slug/staff/:id    → /book/:slug?staff=:id
 *   /s/:slug/reviews      → /book/:slug   (no public review page yet)
 */
export default function ShortLink() {
  const { shopSlug = '', '*': rest = '' } = useParams();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const staff = /^staff\/([^/]+)/.exec(rest)?.[1];
  if (staff && !params.has('staff')) params.set('staff', staff);
  const qs = params.toString();
  return <Navigate to={`/book/${encodeURIComponent(shopSlug)}${qs ? `?${qs}` : ''}`} replace />;
}
