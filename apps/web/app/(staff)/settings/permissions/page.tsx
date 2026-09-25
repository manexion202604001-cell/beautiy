import { PERMISSIONS, PII_DEFAULT_ROLES, ROLES, ROLE_LABEL, ROLE_PERMISSIONS, type Permission, type RoleName } from '@salonos/core';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { PageHeader, Card, Badge, Empty } from '@/components/ui';
import { ConfirmAction } from '@/components/client';
import { fmtDateTime } from '@/lib/format';
import { UNLOCK_MINUTES } from '@/lib/server/pii';
import { revokeUnlockAction, setPiiAccessAction } from './actions';

export const metadata = { title: '権限・個人情報の保護' };

const PERM_LABEL: Record<Permission, string> = {
  'customer.read': '顧客の閲覧', 'customer.write': '顧客の登録・編集', 'customer.pii': '個人情報の常時閲覧', 'customer.merge': '顧客の統合', 'customer.export': '顧客データの出力', 'customer.import': '顧客データの取込',
  'appointment.read': '予約の閲覧', 'appointment.write': '予約の登録・変更',
  'karte.read': 'カルテの閲覧', 'karte.write': 'カルテの記入',
  'pos.checkout': '会計', 'pos.refund': '返金・取消', 'pos.register': 'レジ開閉・精算',
  'message.send': 'メッセージ送信', 'message.broadcast': '一斉配信', 'message.automation': '自動配信の設定',
  'report.read': '売上・分析の閲覧', 'report.export': 'レポートの出力',
  'review.reply': '口コミへの返信', 'profile.edit': '公開プロフィール編集',
  'settings.shop': '店舗設定', 'settings.staff': 'スタッフ管理', 'settings.menu': 'メニュー設定', 'settings.integrations': '外部連携の設定', 'settings.permissions': '権限・個人情報の管理',
  'commerce.manage': '店販EC管理', 'audit.read': '監査ログの閲覧',
};

export default async function PermissionsPage() {
  const ctx = await requirePage('settings.permissions');
  const now = new Date();
  const [members, unlocks] = await Promise.all([
    prisma.membership.findMany({ where: { organizationId: ctx.org.id, active: true }, include: { user: { select: { email: true } } }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    prisma.piiUnlock.findMany({ where: { organizationId: ctx.org.id, expiresAt: { gt: now } }, orderBy: { expiresAt: 'desc' } }),
  ]);
  const byUser = new Map(members.map((m) => [m.userId, m]));
  const tz = ctx.shop.timezone;

  return (
    <>
      <PageHeader title="権限・個人情報の保護" back={{ href: '/settings', label: '設定' }} sub="電話番号・メールアドレス・住所は暗号化して保存され、許可されたスタッフのみ閲覧できます。閲覧はすべて監査ログに記録されます。" />

      <div className="split">
        <Card flush title="スタッフ別の個人情報閲覧">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>スタッフ</th><th>役割</th><th>閲覧</th><th /></tr></thead>
              <tbody>
                {members.map((m) => {
                  const role = m.role as RoleName;
                  const byRole = PII_DEFAULT_ROLES.includes(role);
                  return (
                    <tr key={m.id}>
                      <td><b>{m.displayName}</b><div className="sub">{m.user.email}</div></td>
                      <td>{ROLE_LABEL[role]}</td>
                      <td>{byRole ? <Badge tone="blue">役割で常に許可</Badge> : m.canViewPII ? <Badge tone="violet">個別に許可</Badge> : <Badge>マスク表示</Badge>}</td>
                      <td className="right">
                        {!byRole && (m.canViewPII
                          ? <ConfirmAction action={setPiiAccessAction} fields={{ id: m.id, allow: '0' }} confirm={`${m.displayName} さんの個人情報閲覧許可を取り消しますか？`} className="btn secondary sm">許可を取消</ConfirmAction>
                          : <ConfirmAction action={setPiiAccessAction} fields={{ id: m.id, allow: '1' }} confirm={`${m.displayName} さんに顧客の個人情報（電話・メール・住所）の閲覧を常時許可しますか？`} className="btn sm">閲覧を許可</ConfirmAction>)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="stack">
          <Card title="一時解除（ワンタイムコード）の仕組み">
            <ol style={{ margin: 0, paddingLeft: 18 }} className="stack-sm">
              <li>閲覧が許可されていないスタッフが顧客画面で「一時的に表示」を選ぶと、本人宛に6桁の確認コードが発行されます。</li>
              <li>理由を入力してコードを確認すると、そのスタッフだけ<b>{UNLOCK_MINUTES}分間</b>個人情報を閲覧できます。</li>
              <li>コードの発行・失敗・解除・閲覧はすべて監査ログに記録されます。不要な解除は右下から即時に取り消せます。</li>
            </ol>
          </Card>
          <Card flush title={`有効な一時解除（${unlocks.length}件）`}>
            {unlocks.length === 0 ? <Empty title="現在有効な一時解除はありません" /> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>スタッフ</th><th>理由</th><th>有効期限</th><th /></tr></thead>
                  <tbody>
                    {unlocks.map((u) => (
                      <tr key={u.id}>
                        <td>{byUser.get(u.userId)?.displayName ?? '（無効なスタッフ）'}</td>
                        <td>{u.reason}</td>
                        <td className="nowrap">{fmtDateTime(u.expiresAt, tz)}<div className="sub">残り{Math.max(1, Math.ceil((u.expiresAt.getTime() - now.getTime()) / 60000))}分</div></td>
                        <td className="right"><ConfirmAction action={revokeUnlockAction} fields={{ id: u.id }} confirm="この一時解除を取り消しますか？" className="btn danger-outline sm">取消</ConfirmAction></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>

      <Card className="section" flush title="役割ごとの権限">
        <div className="table-wrap">
          <table className="table perm-matrix">
            <thead><tr><th>権限</th>{ROLES.map((r) => <th key={r}>{ROLE_LABEL[r]}</th>)}</tr></thead>
            <tbody>
              {PERMISSIONS.map((p) => (
                <tr key={p}>
                  <td>{PERM_LABEL[p]}<div className="sub mono">{p}</div></td>
                  {ROLES.map((r) => {
                    const yes = p === 'customer.pii' ? PII_DEFAULT_ROLES.includes(r) : ROLE_PERMISSIONS[r].has(p);
                    return <td key={r}>{yes ? <span className="perm-yes" aria-label="あり">●</span> : <span className="perm-no" aria-label="なし">—</span>}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="sub section">役割の権限は固定です。スタッフの役割は <a className="link" href="/settings/staff">スタッフ管理</a> で変更できます（変更は監査ログに記録されます）。</p>
    </>
  );
}
