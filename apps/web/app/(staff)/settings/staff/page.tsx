import { outranks, PII_DEFAULT_ROLES, ROLES, ROLE_LABEL, type RoleName } from '@salonos/core';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { PageHeader, Card, Field, Badge, Empty, Avatar } from '@/components/ui';
import { ConfirmAction } from '@/components/client';
import { fmtDate, yen } from '@/lib/format';
import { FormModal, RevealModal } from '../_components/client';
import { cancelInviteAction, inviteStaffAction, reissueInviteAction, setMemberActiveAction, updateMemberAction } from './actions';

export const metadata = { title: 'スタッフ管理' };

export default async function StaffSettingsPage() {
  const ctx = await requirePage('settings.staff');
  const orgAdmin = ctx.role === 'OWNER' || ctx.role === 'DIRECTOR';
  const [members, invites, orgShops] = await Promise.all([
    prisma.membership.findMany({
      where: { organizationId: ctx.org.id },
      include: { user: { select: { email: true, isActive: true } }, shops: { select: { shopId: true } } },
      orderBy: [{ active: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.invitation.findMany({ where: { organizationId: ctx.org.id, acceptedAt: null }, orderBy: { createdAt: 'desc' } }),
    prisma.shop.findMany({ where: { organizationId: ctx.org.id }, select: { id: true, name: true, active: true }, orderBy: { createdAt: 'asc' } }),
  ]);
  const assignable = orgAdmin ? orgShops.filter((s) => s.active) : orgShops.filter((s) => ctx.shops.some((x) => x.id === s.id));
  const shopName = new Map(orgShops.map((s) => [s.id, s.name]));
  const grantable = ROLES.filter((r) => ctx.role === 'OWNER' || outranks(ctx.role, r));
  const manageable = (r: RoleName) => ctx.role === 'OWNER' || outranks(ctx.role, r);
  const now = new Date();

  const shopChecks = (selected: string[]) => (
    <div className="field full">
      <span className="label">担当店舗</span>
      <div className="row-wrap">
        {assignable.map((s) => (
          <label key={s.id} className="checkbox"><input type="checkbox" name="shopIds" value={s.id} defaultChecked={selected.includes(s.id)} />{s.name}</label>
        ))}
      </div>
      <div className="hint">オーナー・ディレクターは担当に関わらず全店舗を閲覧できます。</div>
    </div>
  );

  return (
    <>
      <PageHeader
        title="スタッフ"
        back={{ href: '/settings', label: '設定' }}
        sub={`${members.filter((m) => m.active).length}名が有効 ・ 招待中 ${invites.filter((i) => i.expiresAt > now).length}件`}
        actions={
          <RevealModal label="スタッフを招待" title="スタッフを招待" action={inviteStaffAction} submitLabel="招待リンクを発行">
            <div className="form-grid">
              <Field label="氏名" htmlFor="inv-name" required><input id="inv-name" name="name" className="input" required maxLength={60} /></Field>
              <Field label="メールアドレス" htmlFor="inv-email" required><input id="inv-email" name="email" type="email" className="input" required /></Field>
              <Field label="役割" htmlFor="inv-role" required full>
                <select id="inv-role" name="role" className="select" defaultValue="STYLIST">
                  {grantable.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
              </Field>
              {shopChecks([ctx.shop.id])}
            </div>
            <p className="sub" style={{ marginTop: 10 }}>招待リンクは7日間有効です。受け取った本人がパスワードを設定するとログインできるようになります。</p>
          </RevealModal>
        }
      />

      <Card flush title="メンバー">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>スタッフ</th><th>役割</th><th>担当店舗</th><th>ネット予約</th><th className="num">指名料</th><th>個人情報</th><th>状態</th><th /></tr></thead>
            <tbody>
              {members.map((m) => {
                const role = m.role as RoleName;
                const self = m.id === ctx.membership.id;
                const editable = self || manageable(role);
                return (
                  <tr key={m.id} className={m.active ? '' : 'row-muted'}>
                    <td>
                      <div className="row"><Avatar name={m.displayName} src={m.imageUrl} />
                        <div><b>{m.displayName}</b>{self && <> <Badge tone="blue">自分</Badge></>}<div className="sub">{m.user.email}</div></div>
                      </div>
                    </td>
                    <td>{ROLE_LABEL[role]}</td>
                    <td><div className="pill-list">{m.shops.length ? m.shops.map((s) => <Badge key={s.shopId}>{shopName.get(s.shopId) ?? '—'}</Badge>) : <span className="sub">{role === 'OWNER' || role === 'DIRECTOR' ? '全店舗' : '未割当'}</span>}</div></td>
                    <td>{m.bookable ? <Badge tone="green">受付</Badge> : <span className="sub">対象外</span>}</td>
                    <td className="num">{m.nominationFee ? yen(m.nominationFee) : '—'}</td>
                    <td>{PII_DEFAULT_ROLES.includes(role) ? <span className="sub">役割で許可</span> : m.canViewPII ? <Badge tone="violet">許可</Badge> : <span className="sub">マスク</span>}</td>
                    <td>{!m.active ? <Badge>無効</Badge> : !m.user.isActive ? <Badge tone="red">ログイン停止</Badge> : <Badge tone="green">有効</Badge>}</td>
                    <td className="right nowrap">
                      {editable && (
                        <FormModal label="編集" className="btn secondary sm" title={`${m.displayName} の設定`} action={updateMemberAction} wide>
                          <input type="hidden" name="id" value={m.id} />
                          <div className="form-grid">
                            <Field label="表示名" htmlFor={`dn-${m.id}`} required><input id={`dn-${m.id}`} name="displayName" className="input" defaultValue={m.displayName} required maxLength={40} /></Field>
                            <Field label="役割" htmlFor={`rl-${m.id}`} required hint={self ? '自分自身の役割は変更できません' : undefined}>
                              {self ? <><input type="hidden" name="role" value={m.role} /><input id={`rl-${m.id}`} className="input" value={ROLE_LABEL[role]} readOnly /></> : (
                                <select id={`rl-${m.id}`} name="role" className="select" defaultValue={m.role}>
                                  {grantable.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                                </select>
                              )}
                            </Field>
                            {shopChecks(m.shops.map((s) => s.shopId))}
                            <Field label="指名料（円）" htmlFor={`nf-${m.id}`}><input id={`nf-${m.id}`} name="nominationFee" type="number" min={0} max={100000} step={10} className="input" defaultValue={m.nominationFee} /></Field>
                            <Field label="表示順" htmlFor={`so-${m.id}`} hint="小さいほど予約ページで上に表示"><input id={`so-${m.id}`} name="sortOrder" type="number" min={-1000} max={1000} className="input" defaultValue={m.sortOrder} /></Field>
                            <div className="field full"><label className="checkbox"><input type="checkbox" name="bookable" defaultChecked={m.bookable} />ネット予約で指名・自動割当の対象にする</label></div>
                          </div>
                        </FormModal>
                      )}
                      {' '}
                      {!self && manageable(role) && (m.active
                        ? <ConfirmAction action={setMemberActiveAction} fields={{ id: m.id, active: '0' }} confirm={`${m.displayName} さんを無効化しますか？すぐにログアウトされ、ログインできなくなります（予約・カルテ等の履歴は保持されます）。`} className="btn danger-outline sm">無効化</ConfirmAction>
                        : <ConfirmAction action={setMemberActiveAction} fields={{ id: m.id, active: '1' }} className="btn secondary sm">再有効化</ConfirmAction>)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="section" flush title="招待中">
        {invites.length === 0 ? <Empty title="招待中のスタッフはいません" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>氏名</th><th>メール</th><th>役割</th><th>担当店舗</th><th>有効期限</th><th /></tr></thead>
              <tbody>
                {invites.map((i) => {
                  const expired = i.expiresAt < now;
                  const allowed = ctx.role === 'OWNER' || outranks(ctx.role, i.role as RoleName);
                  return (
                    <tr key={i.id} className={expired ? 'row-muted' : ''}>
                      <td>{i.name}</td><td>{i.email}</td><td>{ROLE_LABEL[i.role as RoleName]}</td>
                      <td><div className="pill-list">{i.shopIds.map((s) => <Badge key={s}>{shopName.get(s) ?? '—'}</Badge>)}</div></td>
                      <td>{expired ? <Badge tone="red">期限切れ</Badge> : fmtDate(i.expiresAt, ctx.shop.timezone)}</td>
                      <td className="right nowrap">
                        {allowed && (
                          <RevealModal label="再発行" className="btn secondary sm" title="招待リンクの再発行" action={reissueInviteAction} submitLabel="再発行する">
                            <input type="hidden" name="id" value={i.id} />
                            <p>{i.name}（{i.email}）さんの招待リンクを再発行します。以前のリンクは使えなくなります。</p>
                          </RevealModal>
                        )}{' '}
                        <ConfirmAction action={cancelInviteAction} fields={{ id: i.id }} confirm="この招待を取り消しますか？" className="btn ghost sm">取消</ConfirmAction>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="sub section">個人情報（電話番号・メール・住所）の閲覧許可は <a className="link" href="/settings/permissions">権限・個人情報の保護</a> で設定します。</p>
    </>
  );
}
