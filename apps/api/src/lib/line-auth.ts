import { config } from '../config.js';
import { Errors } from './errors.js';

/**
 * LINE Login / LIFF ID token verification.
 *  - live: POST https://api.line.me/oauth2/v2.1/verify (id_token + client_id = LINE Login channel id)
 *  - mock: token "mock:<userId>[:<displayName>]" (development/test without LINE)
 */
export interface LineProfile {
  userId: string;
  displayName?: string;
  pictureUrl?: string;
  email?: string;
}

export async function verifyLineIdToken(idToken: string, loginChannelId: string | null | undefined): Promise<LineProfile> {
  if (config.LINE_DRIVER === 'mock') {
    const [scheme, userId, displayName] = idToken.split(':');
    if (scheme !== 'mock' || !userId) throw Errors.unauthenticated('LINE認証に失敗しました', 'LINE_AUTH_FAILED');
    return { userId, displayName };
  }
  if (!loginChannelId) throw Errors.business('LINE_NOT_CONFIGURED', 'LINEログインが設定されていません');
  const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: loginChannelId }),
  });
  if (!res.ok) throw Errors.unauthenticated('LINE認証に失敗しました', 'LINE_AUTH_FAILED');
  const body = (await res.json()) as { sub: string; name?: string; picture?: string; email?: string; aud: string; exp: number };
  if (body.aud !== loginChannelId || body.exp * 1000 < Date.now()) throw Errors.unauthenticated('LINE認証に失敗しました', 'LINE_AUTH_FAILED');
  return { userId: body.sub, displayName: body.name, pictureUrl: body.picture, email: body.email };
}
