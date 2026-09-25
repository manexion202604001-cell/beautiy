import { Tabs } from '@/components/ui';

export function CommerceTabs({ active }: { active: 'products' | 'orders' | 'subscriptions' | 'recommendations' }) {
  return (
    <Tabs active={active} items={[
      { key: 'products', href: '/commerce', label: '商品' },
      { key: 'orders', href: '/commerce/orders', label: '注文' },
      { key: 'subscriptions', href: '/commerce/subscriptions', label: '定期便' },
      { key: 'recommendations', href: '/commerce/recommendations', label: 'おすすめリンク' },
    ]} />
  );
}
