import { API_BASE_URL } from './api';

/**
 * Signed file URLs from the API are absolute (`${API_BASE_URL}/v1/files/blob/...`). The API sends
 * `Cross-Origin-Resource-Policy: same-origin`, so when the SPA runs on another origin (Vite dev server,
 * separate web host) <img> previews are blocked. Rewrite URLs that point at the API path to a
 * same-origin relative path served through the `/v1` proxy; other URLs (S3 presigned) are kept.
 */
export function sameOriginApiUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, window.location.origin);
    const base = API_BASE_URL.startsWith('/') ? API_BASE_URL : new URL(API_BASE_URL).pathname;
    if (u.origin !== window.location.origin && u.pathname.startsWith(`${base.replace(/\/$/, '')}/`)) {
      return `${u.pathname}${u.search}`;
    }
    return u.toString();
  } catch {
    return url;
  }
}
