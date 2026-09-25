import { sha256 } from '@salonos/core/crypto';
import { ROLE_LABEL } from '@salonos/core';
import { prisma } from '@/lib/server/db';
import { InviteForm } from './InviteForm';

export const metadata = { title: 'スタッフ招待' };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: sha256(token) }, include: { organization: true } });
  if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) {
    return <div className="auth-card"><div className="card"><h1>招待リンクが無効です</h1><p className="sub">有効期限切れ、または既に使用済みです。管理者に再招待を依頼してください。</p></div></div>;
  }
  return (
    <div className="auth-card">
      <h1>{inv.organization.name} に参加</h1>
      <p className="sub" style={{ marginBottom: 20 }}>{ROLE_LABEL[inv.role]} として招待されています</p>
      <div className="card"><InviteForm token={token} name={inv.name} email={inv.email} /></div>
    </div>
  );
}
