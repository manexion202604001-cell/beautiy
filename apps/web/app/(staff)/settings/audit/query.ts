import type { Prisma } from '@salonos/db';
import { addDays, isDateStr, localToUtc } from '@salonos/core';

export interface AuditFilter { action?: string; user?: string; type?: string; from?: string; to?: string }

export function parseAuditFilter(sp: Record<string, string | undefined>): AuditFilter {
  const s = (v?: string, max = 80) => (v && v.trim() ? v.trim().slice(0, max) : undefined);
  return {
    action: s(sp.action)?.replace(/[^a-zA-Z0-9_.]/g, ''),
    user: s(sp.user, 40),
    type: s(sp.type, 40),
    from: sp.from && isDateStr(sp.from) ? sp.from : undefined,
    to: sp.to && isDateStr(sp.to) ? sp.to : undefined,
  };
}

export function auditWhere(orgId: string, f: AuditFilter, tz: string): Prisma.AuditLogWhereInput {
  return {
    organizationId: orgId,
    ...(f.action ? { action: { startsWith: f.action } } : {}),
    ...(f.user ? { userId: f.user === 'system' ? null : f.user } : {}),
    ...(f.type ? { resourceType: f.type } : {}),
    ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: localToUtc(f.from, 0, tz) } : {}), ...(f.to ? { lt: localToUtc(addDays(f.to, 1), 0, tz) } : {}) } } : {}),
  };
}

export const ACTION_LABELS: [string, string][] = [
  ['customer.pii.read', '個人情報の閲覧'], ['customer.pii.unlock', '個人情報の一時解除'], ['customer.pii.otp', '個人情報 確認コード'],
  ['customer.export', '顧客データの出力'], ['customer.import', '顧客データの取込'], ['customer.merge', '顧客の統合'], ['customer', '顧客'],
  ['permission.pii_changed', '個人情報閲覧権限の変更'], ['permission.pii_unlock_revoked', '一時解除の取消'], ['permission.role_changed', '役割の変更'],
  ['staff.invited', 'スタッフ招待'], ['staff.invite', 'スタッフ招待'], ['staff.deactivated', 'スタッフ無効化'], ['staff.reactivated', 'スタッフ再有効化'], ['staff', 'スタッフ'],
  ['integration.updated', '連携設定の変更'], ['integration.tested', '連携の接続テスト'], ['sync.', '外部予約同期の手動対応'],
  ['report.export', 'レポート出力'], ['audit.export', '監査ログ出力'],
  ['pos.refund', '返金'], ['pos.void', '取消'], ['pos', 'POS'], ['auth.login', 'ログイン'], ['auth.logout', 'ログアウト'], ['auth.password', 'パスワード'],
  ['shop.', '店舗設定'], ['menu.', 'メニュー'], ['coupon.', 'クーポン'], ['org.', '組織'], ['account.', 'アカウント'],
];

export function actionLabel(action: string): string {
  return ACTION_LABELS.find(([p]) => action.startsWith(p))?.[1] ?? '';
}
