// LINE Messaging API helpers (signature + webhook normalization).
import { hmacBase64, safeEqual } from '../crypto';

export function verifyLineSignature(header: string | null, rawBody: string, channelSecret: string): boolean {
  if (!header || !channelSecret) return false;
  return safeEqual(header, hmacBase64(channelSecret, rawBody));
}

export interface LineInbound { eventId: string; type: 'message' | 'follow' | 'unfollow' | 'postback' | 'other'; userId: string | null; text?: string; replyToken?: string; timestamp: number; postbackData?: string }

export function normalizeLineWebhook(rawBody: string): LineInbound[] {
  const j = JSON.parse(rawBody);
  return (j.events ?? []).map((e: any) => ({
    eventId: String(e.webhookEventId ?? `${e.source?.userId}:${e.timestamp}`),
    type: ['message', 'follow', 'unfollow', 'postback'].includes(e.type) ? e.type : 'other',
    userId: e.source?.userId ?? null,
    text: e.message?.type === 'text' ? e.message.text : e.message ? `[${e.message.type}]` : undefined,
    replyToken: e.replyToken,
    timestamp: Number(e.timestamp ?? Date.now()),
    postbackData: e.postback?.data,
  }));
}
