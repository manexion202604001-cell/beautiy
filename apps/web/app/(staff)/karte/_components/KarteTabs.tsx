import { Tabs } from '@/components/ui';

export function KarteTabs({ active }: { active: 'history' | 'templates' | 'forms' }) {
  return (
    <Tabs active={active} items={[
      { key: 'history', label: 'カルテ履歴', href: '/karte' },
      { key: 'templates', label: 'テンプレート', href: '/karte/templates' },
      { key: 'forms', label: 'カウンセリングフォーム', href: '/karte/forms' },
    ]} />
  );
}
