// Web Push with aes128gcm encoding (RFC 8291)
// Required for Apple Push (Safari/iOS) compatibility

type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
};

type PushSubscriptionRecord = {
  id: string;
  staff_id: string;
  endpoint: string;
  subscription_json: string;
};

type WebPushSubscription = {
  endpoint: string;
  keys: { auth: string; p256dh: string };
};

// --- Base64url helpers ---
function base64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const binary = atob(b64 + pad);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function bytesToBase64url(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...arrays: (Uint8Array | ArrayBuffer)[]): Uint8Array {
  const parts = arrays.map(a => a instanceof Uint8Array ? a : new Uint8Array(a));
  const len = parts.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(len);
  let offset = 0;
  for (const p of parts) { result.set(p, offset); offset += p.length; }
  return result;
}

// --- VAPID JWT signing ---
async function createVapidJwt(
  endpoint: string,
  subject: string,
  publicKey: string,
  privateKey: string,
): Promise<{ authorization: string }> {
  const audience = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12 hours

  // Import VAPID private key as ECDSA
  const pubBytes = base64urlToBytes(publicKey);
  const privBytes = base64urlToBytes(privateKey);

  // Build JWK from raw key bytes
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToBase64url(pubBytes.slice(1, 33)),
    y: bytesToBase64url(pubBytes.slice(33, 65)),
    d: bytesToBase64url(privBytes),
  };

  const signingKey = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign'],
  );

  // Build JWT
  const header = bytesToBase64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToBase64url(new TextEncoder().encode(JSON.stringify({ aud: audience, exp, sub: subject })));
  const sigInput = new TextEncoder().encode(`${header}.${payload}`);

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey, sigInput,
  );

  // Convert DER signature to raw r||s format for JWT
  const sig = derToRaw(new Uint8Array(signature));
  const token = `${header}.${payload}.${bytesToBase64url(sig)}`;

  return {
    authorization: `vapid t=${token}, k=${publicKey}`,
  };
}

function derToRaw(der: Uint8Array): Uint8Array {
  // ECDSA signature in DER format: 0x30 <len> 0x02 <rlen> <r> 0x02 <slen> <s>
  // Web Crypto may return raw r||s or DER depending on platform
  if (der.length === 64) return der; // Already raw

  let offset = 2; // Skip 0x30 <len>
  offset++; // Skip 0x02
  const rLen = der[offset++];
  const r = der.slice(offset, offset + rLen);
  offset += rLen;
  offset++; // Skip 0x02
  const sLen = der[offset++];
  const s = der.slice(offset, offset + sLen);

  // Pad to 32 bytes each
  const raw = new Uint8Array(64);
  raw.set(r.length > 32 ? r.slice(r.length - 32) : r, 32 - Math.min(r.length, 32));
  raw.set(s.length > 32 ? s.slice(s.length - 32) : s, 64 - Math.min(s.length, 32));
  return raw;
}

// --- aes128gcm encryption (RFC 8291 + RFC 8188) ---
async function encryptPayloadAes128gcm(
  subscription: WebPushSubscription,
  payloadBytes: Uint8Array,
): Promise<{ body: Uint8Array; localPublicKeyBytes: Uint8Array; salt: Uint8Array }> {
  const authSecret = base64urlToBytes(subscription.keys.auth);
  const clientPublicKeyBytes = base64urlToBytes(subscription.keys.p256dh);

  // Import client public key
  const clientPublicKey = await crypto.subtle.importKey(
    'raw', clientPublicKeyBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, [],
  );

  // Generate local ephemeral keys
  const localKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true, ['deriveBits'],
  );
  const localPublicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', localKeyPair.publicKey),
  );

  // ECDH shared secret
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientPublicKey },
    localKeyPair.privateKey, 256,
  );

  // Salt (random 16 bytes)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF: derive IKM from auth secret and shared secret
  // info = "WebPush: info\0" + clientPubKey + localPubKey
  const ikmInfo = concat(
    new TextEncoder().encode('WebPush: info\0'),
    clientPublicKeyBytes,
    localPublicKeyBytes,
  );

  const ikmKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits']);
  const ikm = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: ikmInfo },
    ikmKey, 256,
  );

  // HKDF: derive CEK
  const prkKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const cekInfo = new TextEncoder().encode('Content-Encoding: aes128gcm\0');
  const cekBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: cekInfo },
    prkKey, 128,
  );

  // HKDF: derive nonce
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\0');
  const nonce = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfo },
    prkKey, 96,
  );

  // Encrypt with AES-128-GCM
  // Padding: add delimiter byte 0x02 after payload
  const padded = concat(payloadBytes, new Uint8Array([2]));

  const cek = await crypto.subtle.importKey('raw', cekBits, 'AES-GCM', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    cek, padded,
  );

  // Build aes128gcm record:
  // salt (16) + rs (4, big-endian uint32) + idlen (1) + keyid (65) + ciphertext
  const rs = 4096; // record size
  const rsBytes = new Uint8Array(4);
  new DataView(rsBytes.buffer).setUint32(0, rs);

  const body = concat(
    salt,                               // 16 bytes
    rsBytes,                            // 4 bytes
    new Uint8Array([localPublicKeyBytes.length]), // 1 byte (65)
    localPublicKeyBytes,                // 65 bytes
    new Uint8Array(encrypted),          // ciphertext
  );

  return { body, localPublicKeyBytes, salt };
}

// --- Result types ---
type PushResult = {
  subscriptionId: string;
  endpoint: string;
  status: number;
  statusText: string;
  responseBody: string;
  success: boolean;
};

// --- Main service ---
export class PushNotificationService {
  static async notifyStaff(
    db: D1Database,
    staffId: string,
    payload: PushPayload,
    vapidPublicKey: string,
    vapidPrivateKey: string,
  ): Promise<{ sent: number; failed: number; details?: PushResult[] }> {
    const staff = await db.prepare(
      'SELECT notify_push, is_active FROM staff WHERE id = ?'
    ).bind(staffId).first<{ notify_push: number; is_active: number }>();

    // 退職スタッフ（is_active=0）にはプッシュ通知を送らない
    if (staff && staff.is_active === 0) {
      console.log(`[Push] Staff ${staffId} is retired (is_active=0) — skipping push`);
      return { sent: 0, failed: 0 };
    }

    if (!staff?.notify_push) {
      console.log(`[Push] Staff ${staffId} has notify_push disabled`);
      return { sent: 0, failed: 0 };
    }

    const subs = await db.prepare(
      'SELECT id, endpoint, subscription_json FROM push_subscriptions WHERE staff_id = ? AND is_active = 1'
    ).bind(staffId).all<PushSubscriptionRecord>();

    console.log(`[Push] Found ${subs.results?.length || 0} active subscriptions for staff ${staffId}`);

    let sent = 0;
    let failed = 0;
    const details: PushResult[] = [];

    for (const sub of subs.results || []) {
      try {
        const subscription: WebPushSubscription = JSON.parse(sub.subscription_json);
        const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));

        console.log(`[Push] Encrypting for ${sub.id}, auth key length: ${subscription.keys.auth.length}, p256dh length: ${subscription.keys.p256dh.length}`);

        // Encrypt with aes128gcm
        const { body } = await encryptPayloadAes128gcm(subscription, payloadBytes);

        console.log(`[Push] Encrypted body size: ${body.byteLength} bytes`);

        // VAPID headers
        const { authorization } = await createVapidJwt(
          subscription.endpoint,
          'mailto:admin@example.com',
          vapidPublicKey,
          vapidPrivateKey,
        );

        // Validate VAPID key sizes
        const pubBytes = base64urlToBytes(vapidPublicKey);
        const privBytes = base64urlToBytes(vapidPrivateKey);
        console.log(`[Push] VAPID public key: ${pubBytes.length} bytes, private key: ${privBytes.length} bytes`);

        const headers: Record<string, string> = {
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'aes128gcm',
          Authorization: authorization,
          TTL: '3600',
          Urgency: 'high',
        };

        console.log(`[Push] Sending to ${sub.id}, endpoint: ${subscription.endpoint.substring(0, 80)}...`);

        const response = await fetch(subscription.endpoint, {
          method: 'POST',
          headers,
          body,
        });

        const responseText = await response.text().catch(() => '');
        console.log(`[Push] Response for ${sub.id}: ${response.status} ${response.statusText} - ${responseText.substring(0, 200)}`);

        const result: PushResult = {
          subscriptionId: sub.id,
          endpoint: subscription.endpoint.substring(0, 80) + '...',
          status: response.status,
          statusText: response.statusText,
          responseBody: responseText.substring(0, 500),
          success: response.status === 201 || response.status === 200,
        };
        details.push(result);

        if (response.status === 201 || response.status === 200) {
          sent++;
          await db.prepare(
            "UPDATE push_subscriptions SET last_used_at = datetime('now') WHERE id = ?"
          ).bind(sub.id).run();
        } else if (response.status === 410 || response.status === 404) {
          await db.prepare(
            'UPDATE push_subscriptions SET is_active = 0 WHERE id = ?'
          ).bind(sub.id).run();
          failed++;
        } else {
          console.error(`Push failed for ${sub.id}: ${response.status} ${responseText}`);
          failed++;
        }
      } catch (error) {
        console.error(`Push error for subscription ${sub.id}:`, error);
        details.push({
          subscriptionId: sub.id,
          endpoint: sub.endpoint?.substring(0, 80) + '...',
          status: 0,
          statusText: 'Error',
          responseBody: error instanceof Error ? error.message : String(error),
          success: false,
        });
        failed++;
      }
    }

    return { sent, failed, details };
  }

  static async notifyAllStoreStaff(
    db: D1Database,
    storeId: string,
    payload: PushPayload,
    vapidPublicKey: string,
    vapidPrivateKey: string,
  ): Promise<{ sent: number; failed: number }> {
    const storeStaff = await db.prepare(
      'SELECT staff_id FROM staff_stores WHERE store_id = ?'
    ).bind(storeId).all<{ staff_id: string }>();

    console.log(`[Push] Notifying all ${storeStaff.results?.length || 0} staff in store ${storeId}`);

    let totalSent = 0;
    let totalFailed = 0;
    for (const s of storeStaff.results || []) {
      const result = await this.notifyStaff(db, s.staff_id, payload, vapidPublicKey, vapidPrivateKey);
      totalSent += result.sent;
      totalFailed += result.failed;
    }
    return { sent: totalSent, failed: totalFailed };
  }

  static async notifyStoreOnCustomerMessage(
    db: D1Database,
    storeId: string,
    customerId: string,
    senderName: string,
    content: string,
    vapidPublicKey: string,
    vapidPrivateKey: string,
  ): Promise<{ sent: number; failed: number }> {
    // 退職スタッフ担当の今後の確定予約があれば、その旨を一文添える
    const retired = await db.prepare(
      `SELECT COALESCE(s.nickname, s.name) AS name
       FROM reservations r JOIN staff s ON s.id = r.staff_id
       WHERE r.customer_id = ? AND r.store_id = ? AND s.is_active = 0
         AND r.status = 'confirmed' AND r.start_at >= datetime('now')
       ORDER BY r.start_at LIMIT 1`
    ).bind(customerId, storeId).first<{ name: string }>();
    const payload: PushPayload = {
      title: retired ? `${retired.name}さんのお客様からメッセージ` : `${senderName}さんからメッセージ`,
      body: retired
        ? `${retired.name}さんのお客様からメッセージが来ました。\n${senderName}様：${content.substring(0, 80)}`
        : content.substring(0, 100),
      url: '/messages',
      tag: `message-${customerId}`,
    };
    const result = await PushNotificationService.notifyAllStoreStaff(db, storeId, payload, vapidPublicKey, vapidPrivateKey);
    return { sent: result.sent, failed: result.failed };
  }
}
