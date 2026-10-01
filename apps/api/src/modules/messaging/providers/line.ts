import { config } from '../../../config.js';
import { sha256 } from '../../../lib/crypto.js';

/**
 * LINE Messaging API adapter (要件 21: プロバイダ固有仕様は Adapter 層に隔離).
 *  - push:      POST /v2/bot/message/push      (X-Line-Retry-Key makes retries idempotent)
 *  - multicast: POST /v2/bot/message/multicast (≤500 recipients per request)
 *  - profile:   GET  /v2/bot/profile/{userId}  (404 when the user is not a friend)
 *  - bot info:  GET  /v2/bot/info              (credential verification / webhook destination)
 *
 * Errors are normalized to LineApiError: `retryable` (429 / 5xx / network) or permanent (other 4xx).
 * LINE_DRIVER=mock records sends to `lineMock.outbox` instead of calling the API.
 */
const API = 'https://api.line.me';
export const MULTICAST_LIMIT = 500;

export type LineMessage =
  | { type: 'text'; text: string }
  | { type: 'image'; originalContentUrl: string; previewImageUrl: string }
  | { type: 'flex'; altText: string; contents: unknown }
  | { type: 'template'; altText: string; template: unknown };

export class LineApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LineApiError';
  }
}

export interface LineSendResult {
  /** x-line-request-id (or accepted request id on idempotent replay) */
  requestId: string;
  /** per-message ids returned by push */
  sentMessageIds: string[];
}

export interface LineProfileResult {
  userId: string;
  displayName?: string;
  pictureUrl?: string;
  statusMessage?: string;
}

export interface LineBotInfo {
  userId: string;
  basicId?: string;
  displayName?: string;
}

// ---------------------------------------------------------------- mock driver

export interface LineMockSend {
  kind: 'push' | 'multicast';
  to: string[];
  messages: LineMessage[];
  retryKey: string | null;
  accessToken: string;
  requestId: string;
}

type MockFailure = { kind: 'retry' | 'permanent'; status?: number; message?: string; /** only fail sends that include this recipient */ to?: string };

/** In-memory state of the mock driver (inspected and steered by tests) */
export const lineMock = {
  outbox: [] as LineMockSend[],
  /** queued failures consumed by the next push/multicast calls */
  failures: [] as MockFailure[],
  /** userIds for which getProfile answers 404 (not a friend) */
  notFriends: new Set<string>(),
  profiles: new Map<string, { displayName?: string; pictureUrl?: string }>(),
  /** access tokens rejected by getBotInfo (invalid credentials) */
  invalidTokens: new Set<string>(),
  failNext(kind: MockFailure['kind'], times = 1, opts: { status?: number; to?: string } = {}) {
    for (let i = 0; i < times; i++) this.failures.push({ kind, ...opts });
  },
  sentTo(userId: string) {
    return this.outbox.filter((s) => s.to.includes(userId));
  },
  reset() {
    this.outbox.length = 0;
    this.failures.length = 0;
    this.notFriends.clear();
    this.profiles.clear();
    this.invalidTokens.clear();
  },
};

/** bot userId derived from the access token in mock mode (stable, used as webhook destination) */
export function mockBotUserId(accessToken: string): string {
  return `U${sha256(`bot:${accessToken}`).slice(0, 32)}`;
}

function mockSend(kind: LineMockSend['kind'], accessToken: string, to: string[], messages: LineMessage[], retryKey: string | null): LineSendResult {
  if (retryKey) {
    // LINE accepts a retry key once; a replay returns 409 with the accepted request id
    const prior = lineMock.outbox.find((s) => s.retryKey === retryKey);
    if (prior) return { requestId: prior.requestId, sentMessageIds: [] };
  }
  const idx = lineMock.failures.findIndex((f) => !f.to || to.includes(f.to));
  const failure = idx >= 0 ? lineMock.failures.splice(idx, 1)[0] : undefined;
  if (failure) {
    const status = failure.status ?? (failure.kind === 'retry' ? 500 : 400);
    throw new LineApiError(failure.message ?? `LINE mock failure (${status})`, status, failure.kind === 'retry', failure.kind === 'retry' ? 1000 : undefined);
  }
  const requestId = `mock-line-${lineMock.outbox.length + 1}-${Date.now()}`;
  lineMock.outbox.push({ kind, to, messages, retryKey, accessToken, requestId });
  if (lineMock.outbox.length > 1000) lineMock.outbox.shift();
  if (config.NODE_ENV === 'development') console.info(`[line:mock] ${kind} to=${to.join(',')} ${JSON.stringify(messages)}`);
  return { requestId, sentMessageIds: messages.map((_, i) => `${requestId}-${i}`) };
}

// ---------------------------------------------------------------- live driver

async function call(method: 'GET' | 'POST', path: string, accessToken: string, body?: unknown, retryKey?: string | null): Promise<{ res: Response; json: unknown }> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(retryKey ? { 'x-line-retry-key': retryKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new LineApiError(`LINE API network error: ${(err as Error).message}`, 0, true);
  }
  const json = await res.json().catch(() => null);
  return { res, json };
}

function toError(res: Response, json: unknown): LineApiError {
  const message = (json as { message?: string } | null)?.message ?? res.statusText;
  const retryable = res.status === 429 || res.status >= 500;
  const retryAfter = Number(res.headers.get('retry-after'));
  return new LineApiError(`LINE API ${res.status}: ${message}`, res.status, retryable, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
}

async function send(path: string, kind: LineMockSend['kind'], accessToken: string, to: string[], messages: LineMessage[], retryKey: string | null, body: unknown): Promise<LineSendResult> {
  if (config.LINE_DRIVER === 'mock') return mockSend(kind, accessToken, to, messages, retryKey);
  const { res, json } = await call('POST', path, accessToken, body, retryKey);
  if (res.status === 409 && retryKey) {
    // already accepted with this retry key → idempotent success
    return { requestId: res.headers.get('x-line-accepted-request-id') ?? res.headers.get('x-line-request-id') ?? retryKey, sentMessageIds: [] };
  }
  if (!res.ok) throw toError(res, json);
  const sent = ((json as { sentMessages?: { id: string }[] } | null)?.sentMessages ?? []).map((m) => m.id);
  return { requestId: res.headers.get('x-line-request-id') ?? '', sentMessageIds: sent };
}

/** Push messages to one user. retryKey must be a UUID (we use the message id). */
export function linePush(accessToken: string, to: string, messages: LineMessage[], retryKey: string | null): Promise<LineSendResult> {
  return send('/v2/bot/message/push', 'push', accessToken, [to], messages, retryKey, { to, messages });
}

/** Multicast the same messages to up to 500 users */
export function lineMulticast(accessToken: string, to: string[], messages: LineMessage[], retryKey: string | null): Promise<LineSendResult> {
  if (to.length === 0) return Promise.resolve({ requestId: '', sentMessageIds: [] });
  if (to.length > MULTICAST_LIMIT) throw new Error(`multicast supports at most ${MULTICAST_LIMIT} recipients`);
  return send('/v2/bot/message/multicast', 'multicast', accessToken, to, messages, retryKey, { to, messages });
}

/** Friend profile; null when the user is not a friend (or blocked the account) */
export async function lineGetProfile(accessToken: string, userId: string): Promise<LineProfileResult | null> {
  if (config.LINE_DRIVER === 'mock') {
    if (lineMock.notFriends.has(userId)) return null;
    const p = lineMock.profiles.get(userId);
    return { userId, displayName: p?.displayName ?? `LINEユーザー${userId.slice(-4)}`, pictureUrl: p?.pictureUrl };
  }
  const { res, json } = await call('GET', `/v2/bot/profile/${encodeURIComponent(userId)}`, accessToken);
  if (res.status === 404) return null;
  if (!res.ok) throw toError(res, json);
  return json as LineProfileResult;
}

/** Verify a channel access token and read the bot's own userId (= webhook "destination") */
export async function lineGetBotInfo(accessToken: string): Promise<LineBotInfo> {
  if (config.LINE_DRIVER === 'mock') {
    if (lineMock.invalidTokens.has(accessToken) || accessToken.length < 8) throw new LineApiError('LINE API 401: Authentication failed', 401, false);
    return { userId: mockBotUserId(accessToken), basicId: '@mock', displayName: 'Mock LINE OA' };
  }
  const { res, json } = await call('GET', '/v2/bot/info', accessToken);
  if (!res.ok) throw toError(res, json);
  return json as LineBotInfo;
}

/** LINE text messages are limited to 5000 characters */
export function textMessage(text: string): LineMessage {
  return { type: 'text', text: text.length > 5000 ? `${text.slice(0, 4999)}…` : text };
}
