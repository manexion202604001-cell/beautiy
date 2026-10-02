// Strip secret columns from DB rows before returning them in API responses.
// DB queries may SELECT * for convenience; these helpers are the response-side guard.

const STORE_SECRETS = ['salonboard_password', 'line_channel_secret', 'line_access_token', 'lime_password'] as const;
const CUSTOMER_SECRETS = ['password_hash'] as const;
const STAFF_SECRETS = ['password_hash', 'line_notify_token', 'verification_token', 'verification_token_expires_at', 'totp_secret', 'password_reset_token', 'password_reset_token_expires_at'] as const;

function strip<T extends Record<string, unknown>>(obj: T | null | undefined, fields: readonly string[]): T | null {
  if (!obj) return obj ?? null;
  const copy: Record<string, unknown> = { ...obj };
  for (const f of fields) delete copy[f];
  return copy as T;
}

export function sanitizeStore<T extends Record<string, unknown>>(store: T | null | undefined): T | null {
  return strip(store, STORE_SECRETS);
}

export function sanitizeCustomer<T extends Record<string, unknown>>(customer: T | null | undefined): T | null {
  return strip(customer, CUSTOMER_SECRETS);
}

export function sanitizeCustomers<T extends Record<string, unknown>>(customers: T[]): T[] {
  return customers.map((r) => strip(r, CUSTOMER_SECRETS) as T);
}

export function sanitizeStaff<T extends Record<string, unknown>>(staff: T | null | undefined): T | null {
  return strip(staff, STAFF_SECRETS);
}
