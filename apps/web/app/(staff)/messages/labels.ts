// Client-safe labels for the messaging module.
import type { Tone } from '@/components/ui';

export const TEMPLATE_CATEGORIES: Record<string, string> = {
  BOOKING_CONFIRMED: '予約確定',
  BOOKING_REQUESTED: '予約リクエスト受付',
  BOOKING_CHANGED: '予約変更',
  BOOKING_CANCELLED: '予約キャンセル',
  REMINDER: 'リマインド',
  FOLLOW_UP: '来店後フォロー',
  REVIEW_REQUEST: '口コミ依頼',
  KARTE_SHARE: 'カルテ共有',
  GENERAL: '一般',
};

export const CHANNEL_LABEL: Record<string, string> = { LINE: 'LINE', EMAIL: 'メール', SMS: 'SMS', PUSH: 'プッシュ' };
export const CHANNEL_TONE: Record<string, Tone> = { LINE: 'green', EMAIL: 'blue', SMS: 'violet', PUSH: 'gray' };

export const STATUS_LABEL: Record<string, string> = {
  QUEUED: '送信待ち', SENT: '送信済み', DELIVERED: '配信済み', FAILED: '失敗', RECEIVED: '受信', SKIPPED: '対象外（停止/連絡先なし）',
};
export const STATUS_SHORT: Record<string, string> = { QUEUED: '送信待ち', SENT: '送信済み', DELIVERED: '配信済み', FAILED: '失敗', RECEIVED: '受信', SKIPPED: 'スキップ' };
export const STATUS_TONE: Record<string, Tone> = { QUEUED: 'amber', SENT: 'green', DELIVERED: 'green', FAILED: 'red', RECEIVED: 'blue', SKIPPED: 'gray' };

export const TRIGGER_LABEL: Record<string, string> = {
  REMINDER_BEFORE: '予約前リマインド',
  VISIT_CYCLE: '来店周期フォロー',
  AFTER_VISIT_REVIEW: '来店後の口コミ依頼',
  BIRTHDAY: '誕生日',
  DORMANT: '休眠掘り起こし',
};
export const TRIGGER_UNIT: Record<string, string> = {
  REMINDER_BEFORE: '時間前', VISIT_CYCLE: '日経過', AFTER_VISIT_REVIEW: '時間後', BIRTHDAY: '', DORMANT: '日経過',
};
export const TRIGGER_HELP: Record<string, string> = {
  REMINDER_BEFORE: '確定済み予約の開始N時間前までに1回送信します。',
  VISIT_CYCLE: '最終来店からN日経過し、次回予約がないお客様へ送信します（経過後30日以内の方が対象）。',
  AFTER_VISIT_REVIEW: '施術完了（予約終了）からN時間後、口コミ未投稿のお客様へ送信します（7日以内の来店が対象）。',
  BIRTHDAY: 'お誕生日当日（店舗の時刻）に年1回送信します。',
  DORMANT: '最終来店からN日以上経過し、次回予約がないお客様へ1回送信します。',
};

export const BROADCAST_STATUS: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: '下書き', tone: 'gray' },
  SCHEDULED: { label: '予約配信', tone: 'violet' },
  SENDING: { label: '送信中', tone: 'amber' },
  SENT: { label: '送信完了', tone: 'green' },
};

export const SAMPLE_VARS: Record<string, string> = {
  customer_name: '山田 花子', shop_name: '青山店', staff_name: '佐藤', date: '10/3(金)', time: '14:00', menu: 'カット・カラー',
  manage_url: 'https://example.com/booking/xxxx', booking_url: 'https://example.com/book/shop', review_url: 'https://example.com/review/xxxx',
  karte_url: 'https://example.com/k/xxxx', days_since: '45',
};
