// TOTP (RFC 6238) implementation using Web Crypto API
// Compatible with Google Authenticator, Authy, etc.

const TOTP_PERIOD = 30; // seconds
const TOTP_DIGITS = 6;

// Generate a random TOTP secret (base32 encoded)
export function generateTotpSecret(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

// Generate TOTP code for a given secret and time
export async function generateTotp(secret: string, time?: number): Promise<string> {
  const t = time ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(t / TOTP_PERIOD);
  return hmacOtp(secret, counter);
}

// Verify TOTP code with ±1 window (allows 30s clock drift)
export async function verifyTotp(secret: string, code: string): Promise<boolean> {
  const t = Math.floor(Date.now() / 1000);
  const counter = Math.floor(t / TOTP_PERIOD);

  for (const offset of [-1, 0, 1]) {
    const expected = await hmacOtp(secret, counter + offset);
    if (timingSafeEqual(code, expected)) return true;
  }
  return false;
}

// Generate otpauth:// URI for QR code
export function buildTotpUri(secret: string, account: string, issuer: string = 'SALOGIC'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}

// --- Internal helpers ---

async function hmacOtp(secret: string, counter: number): Promise<string> {
  const keyBytes = base32Decode(secret);
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );

  const counterBuf = new ArrayBuffer(8);
  const view = new DataView(counterBuf);
  view.setBigUint64(0, BigInt(counter));

  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBuf));

  // Dynamic truncation (RFC 4226)
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binary % Math.pow(10, TOTP_DIGITS);
  return otp.toString().padStart(TOTP_DIGITS, '0');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// Base32 encoding/decoding (RFC 4648)
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(data: Uint8Array): string {
  let result = '';
  let bits = 0;
  let value = 0;
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32_CHARS[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    result += BASE32_CHARS[(value << (5 - bits)) & 0x1f];
  }
  return result;
}

function base32Decode(encoded: string): Uint8Array {
  const cleaned = encoded.replace(/[=\s]/g, '').toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of cleaned) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}
