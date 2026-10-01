import { Navigate, useLocation, useParams } from 'react-router';

/** /s/:shopSlug (short booking link used in messages) → /book/:shopSlug, keeping the query string */
export default function ShopRedirect() {
  const { shopSlug = '' } = useParams();
  const { search } = useLocation();
  return <Navigate to={`/book/${encodeURIComponent(shopSlug)}${search}`} replace />;
}
