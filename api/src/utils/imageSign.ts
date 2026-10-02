// Signed URLs for protected R2 images (karute photos).
// Format: /images/<key>?exp=<unix-seconds>&sig=<hex hmac-sha256(key|exp)>

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// R2 key prefixes that require a valid signature to be served
export function isProtectedImageKey(key: string): boolean {
  return key.startsWith('karutes/');
}

// Append exp/sig query params to an image_url path like /images/karutes/...
export async function signImageUrl(imageUrl: string, secret: string, ttlSeconds = 7 * 24 * 3600): Promise<string> {
  const key = imageUrl.replace(/^\/images\//, '').split('?')[0];
  if (!isProtectedImageKey(key)) return imageUrl;
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await hmacHex(secret, `${key}|${exp}`);
  return `/images/${key}?exp=${exp}&sig=${sig}`;
}

export async function verifyImageSig(key: string, exp: string | undefined, sig: string | undefined, secret: string): Promise<boolean> {
  if (!exp || !sig) return false;
  const expNum = parseInt(exp, 10);
  if (!expNum || expNum < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacHex(secret, `${key}|${expNum}`);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// Sign image_url on a list of rows (helper for API responses)
export async function signImageRows<T extends { image_url: string }>(rows: T[], secret: string): Promise<T[]> {
  return Promise.all(rows.map(async (r) => ({ ...r, image_url: await signImageUrl(r.image_url, secret) })));
}
