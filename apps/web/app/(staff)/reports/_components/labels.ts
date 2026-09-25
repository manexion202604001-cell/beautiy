import type { Lifecycle } from '@salonos/core';
import type { Tone } from '@/components/ui';

export const LC_TONE: Record<Lifecycle, Tone> = { NEW: 'green', ACTIVE: 'blue', DUE: 'amber', OVERDUE: 'red', DORMANT: 'violet', PROSPECT: 'gray' };

export const PAYMENT_LABEL: Record<string, string> = {
  CASH: '現金', CARD: 'クレジットカード', EMONEY: '電子マネー', QR: 'QRコード決済', STRIPE: 'オンライン決済（Stripe）', SQUARE: 'Square端末', CUSTOM: 'その他',
};

export const fmtCount = (n: number) => n.toLocaleString('ja-JP');
export const fmtPct = (r: number, digits = 1) => `${(r * 100).toFixed(digits)}%`;

export function bucketLabel(bucket: string, gran: 'day' | 'month') {
  if (gran === 'month') { const [y, m] = bucket.split('-'); return `${y.slice(2)}/${Number(m)}月`; }
  const [, m, d] = bucket.split('-');
  return `${Number(m)}/${Number(d)}`;
}
export function bucketTip(bucket: string, gran: 'day' | 'month') {
  if (gran === 'month') { const [y, m] = bucket.split('-'); return `${y}年${Number(m)}月`; }
  const dt = new Date(bucket + 'T00:00:00Z');
  return `${bucket.replaceAll('-', '/')}（${'日月火水木金土'[dt.getUTCDay()]}）`;
}
