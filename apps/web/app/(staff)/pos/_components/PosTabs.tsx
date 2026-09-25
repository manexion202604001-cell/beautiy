import { Tabs } from '@/components/ui';

export function PosTabs({ active, canRegister }: { active: 'home' | 'transactions' | 'register' | 'daily'; canRegister: boolean }) {
  const items = [
    { key: 'home', href: '/pos', label: '会計' },
    { key: 'transactions', href: '/pos/transactions', label: '取引履歴' },
    ...(canRegister ? [{ key: 'register', href: '/pos/register', label: 'レジ開け・締め' }, { key: 'daily', href: '/pos/register/daily', label: '日次レポート' }] : []),
  ];
  return <div className="no-print"><Tabs items={items} active={active} /></div>;
}
