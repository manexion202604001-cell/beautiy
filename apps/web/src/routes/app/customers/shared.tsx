/** Small pieces shared by the customer screens (list, detail, karte). */

export function LineIcon({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="#06C755" role="img" aria-label="LINE連携済み">
      <path d="M12 2C6.48 2 2 5.83 2 10.5c0 4.08 3.42 7.5 8.05 8.35.31.07.74.21.85.48.1.25.07.63.03.88l-.14.82c-.04.25-.2.97.85.53s5.61-3.3 7.65-5.65C21.22 13.78 22 12.2 22 10.5 22 5.83 17.52 2 12 2z" />
    </svg>
  );
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Date wording of the customer screens:
 *  date     2026年10月13日(火)
 *  short    10月13日
 *  datetime 2026年10月13日 14:30
 * A calendar date (YYYY-MM-DD, e.g. a karte's visit date) is shown as it is; an instant is shown
 * in the shop's timezone.
 */
export function formatWhen(value: string, tz: string, style: 'date' | 'short' | 'datetime' = 'datetime'): string {
  const dateOnly = DATE_ONLY.test(value);
  const d = new Date(dateOnly ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return value;
  const timeZone = dateOnly ? 'UTC' : tz;
  switch (style) {
    case 'date':
      return d.toLocaleDateString('ja-JP', { timeZone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
    case 'short':
      return d.toLocaleDateString('ja-JP', { timeZone, month: 'short', day: 'numeric' });
    default:
      return d.toLocaleString('ja-JP', { timeZone, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
}

/** 集客元: customers a staff member brought in personally (the rest came through the shop) */
export const isStaffOrigin = (acquisitionSource: string | null | undefined) =>
  acquisitionSource === 'staff' || acquisitionSource === 'スタッフ集客';

/** "山田 花子" → ["山田", "花子"] (first word = family name, the rest = given name) */
export function splitName(full: string | null | undefined): [string, string] {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  return [parts[0] ?? '', parts.slice(1).join(' ')];
}

/** Address for a 7-digit postal code (zipcloud); null when unknown or unreachable */
export async function lookupAddress(postalCode: string): Promise<string | null> {
  const digits = postalCode.replace(/-/g, '');
  if (digits.length !== 7 || !/^\d+$/.test(digits)) return null;
  try {
    const res = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${digits}`);
    const body = (await res.json()) as { results?: { address1: string; address2: string; address3: string }[] | null };
    const hit = body.results?.[0];
    return hit ? `${hit.address1}${hit.address2}${hit.address3}` : null;
  } catch {
    return null;
  }
}
