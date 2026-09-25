// Post-login redirect target validation (shared by the login page and loginAction).
// Only same-origin absolute paths are allowed: "/x" but never "//host", "/\host", or paths
// containing backslashes / control characters (browsers strip tab/newline, so "/\t/host"
// would become "//host").
export const DEFAULT_AFTER_LOGIN = '/dashboard';

export function safeNextPath(next: unknown, fallback = DEFAULT_AFTER_LOGIN): string {
  if (typeof next !== 'string' || next.length > 2000) return fallback;
  if (!/^\/(?!\/|\\)/.test(next)) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  return next;
}
