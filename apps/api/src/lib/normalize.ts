/**
 * Normalization helpers for identity resolution (名寄せ).
 */

/** Normalize Japanese phone numbers to E.164 (+81...). Returns null when not plausibly a phone number. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  // full-width digits -> half-width, strip separators
  const half = input.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[＋]/g, '+');
  let digits = half.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) {
    digits = '+' + digits.slice(1).replace(/\+/g, '');
    return digits.length >= 10 ? digits : null;
  }
  digits = digits.replace(/\+/g, '');
  if (digits.startsWith('0') && (digits.length === 10 || digits.length === 11)) {
    return '+81' + digits.slice(1);
  }
  if (digits.startsWith('81') && (digits.length === 11 || digits.length === 12)) return '+' + digits;
  return digits.length >= 10 ? digits : null;
}

export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const v = input.trim().toLowerCase();
  return v.includes('@') ? v : null;
}

/** Convert hiragana to katakana, full-width ASCII to half-width, and strip whitespace */
export function normalizeKana(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .normalize('NFKC')
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[\s　]+/g, '')
    .toLowerCase();
}

export function normalizeName(input: string | null | undefined): string {
  return (input ?? '').normalize('NFKC').replace(/[\s　]+/g, '').toLowerCase();
}

/** Levenshtein-based similarity in [0,1] */
export function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - dp[n]! / Math.max(m, n);
}
