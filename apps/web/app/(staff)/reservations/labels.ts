// Client-safe labels for the reservation ledger (booking.ts is server-only).
import type { Tone } from '@/components/ui';

export const STATUS_LABEL: Record<string, string> = {
  REQUESTED: 'リクエスト', CONFIRMED: '確定', ARRIVED: '来店', IN_SERVICE: '施術中', COMPLETED: '完了', CANCELLED: 'キャンセル', NO_SHOW: '無断キャンセル',
};

export const STATUS_TONE: Record<string, Tone> = {
  REQUESTED: 'amber', CONFIRMED: 'blue', ARRIVED: 'green', IN_SERVICE: 'violet', COMPLETED: 'gray', CANCELLED: 'red', NO_SHOW: 'red',
};

/** Verb shown on the transition button. */
export const STATUS_ACTION: Record<string, string> = {
  REQUESTED: 'リクエストに戻す', CONFIRMED: '確定にする', ARRIVED: '来店', IN_SERVICE: '施術開始', COMPLETED: '完了', CANCELLED: 'キャンセル', NO_SHOW: '無断キャンセル',
};

export const SOURCE_LABEL: Record<string, string> = {
  STAFF: '店頭', WEB: 'ネット', LINE: 'LINE', PHONE: '電話', INSTAGRAM: 'Instagram', GOOGLE: 'Google', HOTPEPPER: '外部サイト', MINIMO: '外部サイト', RAKUTEN: '外部サイト', OTHER: 'その他',
};

export const KIND_LABEL: Record<string, string> = { NORMAL: '通常', CONSULTATION: '相談', PRIVATE: 'プライベート' };

export const WAIT_STATUS_LABEL: Record<string, string> = { WAITING: '待機中', CONTACTED: '連絡済み', BOOKED: '予約済み', CLOSED: 'クローズ' };
export const WAIT_STATUS_TONE: Record<string, Tone> = { WAITING: 'amber', CONTACTED: 'blue', BOOKED: 'green', CLOSED: 'gray' };
