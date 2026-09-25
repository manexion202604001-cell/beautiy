import { Tabs } from '@/components/ui';

export function MessagesNav({ active, can }: { active: 'inbox' | 'templates' | 'broadcasts' | 'automations' | 'logs'; can: { broadcast: boolean; automation: boolean } }) {
  const items = [
    { key: 'inbox', href: '/messages', label: '受信箱' },
    { key: 'templates', href: '/messages/templates', label: 'テンプレート' },
    ...(can.broadcast ? [{ key: 'broadcasts', href: '/messages/broadcasts', label: '一斉配信' }] : []),
    ...(can.automation ? [{ key: 'automations', href: '/messages/automations', label: '自動配信' }] : []),
    { key: 'logs', href: '/messages/logs', label: '配信ログ' },
  ];
  return <Tabs items={items} active={active} />;
}
