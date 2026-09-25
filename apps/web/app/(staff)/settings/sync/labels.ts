import type { SyncStatus } from '@salonos/db';
import type { Tone } from '@/components/ui';
import { PROVIDER_BY_KEY } from '../integrations/providers';

export const SYNC_TONE: Record<SyncStatus, Tone> = { PENDING: 'blue', PROCESSING: 'violet', DONE: 'green', FAILED: 'amber', DEAD: 'red', CONFLICT: 'red' };
export const PROBLEM: SyncStatus[] = ['FAILED', 'DEAD', 'CONFLICT'];
export const providerLabel = (p: string) => PROVIDER_BY_KEY[p]?.label ?? p;

export const ACTION_LABEL: Record<string, string> = {
  created: '新規登録', updated: '変更を反映', cancelled: 'キャンセルを反映', unchanged: '変更なし', stale: '古い通知のため破棄',
  cancel_unknown: '未登録予約のキャンセル', linked: '既存予約に紐付け', ignored: '無視', pushed: '送信済み', noop: '送信対象なし',
};

/** Original provider event id (stored namespaced as `<integrationId>:<eventId>`). */
export function displayEventId(externalEventId: string, integrationId: string | null) {
  return integrationId && externalEventId.startsWith(integrationId + ':') ? externalEventId.slice(integrationId.length + 1) : externalEventId;
}

const PII_KEYS = /^(phone|tel|telephone|mobile|email|mail|address|addr)$/i;
/** Mask contact PII inside raw provider payloads for display. */
export function maskPayload(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskPayload);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, PII_KEYS.test(k) && typeof x === 'string' ? (x.length > 4 ? `${'*'.repeat(Math.min(8, x.length - 4))}${x.slice(-4)}` : '****') : maskPayload(x)]));
  }
  return v;
}
