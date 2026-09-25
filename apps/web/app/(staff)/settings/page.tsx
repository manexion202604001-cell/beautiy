import Link from 'next/link';
import { Store, Clock, Building2, Users, Scissors, ShieldCheck, Plug, RefreshCw, ScrollText, UserCog } from 'lucide-react';
import type { Permission } from '@salonos/core';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { PageHeader, Badge } from '@/components/ui';

export const metadata = { title: '設定' };

interface Section { href: string; title: string; desc: string; icon: React.ReactNode; perm?: Permission; roles?: string[] }

const SECTIONS: Section[] = [
  { href: '/settings/shop', title: '店舗情報・予約ルール', desc: '席数、予約受付モード、キャンセル期限、税率、公開URL', icon: <Store />, perm: 'settings.shop' },
  { href: '/settings/hours', title: '営業時間・休業日', desc: '曜日ごとの営業時間と臨時休業日のカレンダー', icon: <Clock />, perm: 'settings.shop' },
  { href: '/settings/shops', title: '店舗管理（複数店舗）', desc: '店舗の追加・停止と全店舗の売上サマリー', icon: <Building2 />, perm: 'settings.shop', roles: ['OWNER', 'DIRECTOR'] },
  { href: '/settings/staff', title: 'スタッフ', desc: '招待、役割、担当店舗、ネット予約の受付、無効化', icon: <Users />, perm: 'settings.staff' },
  { href: '/settings/menus', title: 'メニュー・クーポン', desc: 'メニュー・所要時間・料金とクーポンの管理', icon: <Scissors />, perm: 'settings.menu' },
  { href: '/settings/permissions', title: '権限・個人情報の保護', desc: '役割ごとの権限、個人情報の閲覧許可と一時解除の管理', icon: <ShieldCheck />, perm: 'settings.permissions' },
  { href: '/settings/integrations', title: '外部連携', desc: 'LINE、決済（Stripe / Square）、Google、Instagram、外部予約サイト', icon: <Plug />, perm: 'settings.integrations' },
  { href: '/settings/sync', title: '外部予約の同期状況', desc: '同期エラーの確認、再試行、競合の解消', icon: <RefreshCw />, perm: 'settings.integrations' },
  { href: '/settings/audit', title: '監査ログ', desc: '個人情報の閲覧・出力、権限変更などの操作履歴', icon: <ScrollText />, perm: 'audit.read' },
  { href: '/settings/account', title: 'アカウント', desc: '表示名とパスワードの変更', icon: <UserCog /> },
];

export default async function SettingsIndex() {
  const ctx = await requirePage();
  const visible = SECTIONS.filter((s) => (!s.perm || ctx.can(s.perm)) && (!s.roles || s.roles.includes(ctx.role)));
  const syncIssues = ctx.can('settings.integrations')
    ? await prisma.syncEvent.count({ where: { organizationId: ctx.org.id, status: { in: ['FAILED', 'DEAD', 'CONFLICT'] } } })
    : 0;
  return (
    <>
      <PageHeader title="設定" sub={`${ctx.org.name} ・ ${ctx.shop.name}`} />
      <div className="settings-grid">
        {visible.map((s) => (
          <Link key={s.href} href={s.href} className="settings-link">
            <span className="ico" aria-hidden="true">{s.icon}</span>
            <span>
              <h3>{s.title} {s.href === '/settings/sync' && syncIssues > 0 && <Badge tone="red">{syncIssues}件</Badge>}</h3>
              <span className="sub">{s.desc}</span>
            </span>
          </Link>
        ))}
      </div>
    </>
  );
}
