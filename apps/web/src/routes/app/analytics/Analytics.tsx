import { useSearchParams } from 'react-router';
import { Forbidden } from '../../../components/Forbidden';
import { PageHeader, TabPanel, Tabs, type TabItem } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { AiTab } from './AiTab';
import { CustomersTab, LtvTab, RepeatTab } from './CustomerTabs';
import { FilterBar, useAnalyticsFilters } from './filters';
import { ChannelsTab, MenusTab, StaffTab } from './MixTabs';
import { SalesTab } from './SalesTab';

type Tab = 'sales' | 'customers' | 'repeat' | 'ltv' | 'menus' | 'staff' | 'channels' | 'ai';

/**
 * 分析 (S-80〜S-84). analytics.read sees every report for accessible shops;
 * analytics.read_own (stylists) only sees 売上/スタッフ with their own figures — other tabs are hidden.
 */
export default function Analytics() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [filters, update] = useAnalyticsFilters();
  const full = can('analytics.read');
  const sales = full || can('sales.read') || can('sales.read_own') || can('analytics.read_own');
  const staff = full || can('analytics.read_own');
  const ai = can('ai.use') && (can('customer.read') || full || can('sales.read'));
  const items: TabItem<Tab>[] = [
    ...(sales ? [{ value: 'sales' as const, label: '売上' }] : []),
    ...(full
      ? [
          { value: 'customers' as const, label: '顧客' },
          { value: 'repeat' as const, label: 'リピート率' },
          { value: 'ltv' as const, label: 'LTV' },
          { value: 'menus' as const, label: 'メニュー構成比' },
        ]
      : []),
    ...(staff ? [{ value: 'staff' as const, label: 'スタッフ生産性' }] : []),
    ...(full ? [{ value: 'channels' as const, label: '予約経路' }] : []),
    ...(ai ? [{ value: 'ai' as const, label: 'AIインサイト' }] : []),
  ];
  const requested = params.get('tab') as Tab | null;
  const tab = items.find((i) => i.value === requested)?.value ?? items[0]?.value;
  if (!tab) return <Forbidden permission="analytics.read / analytics.read_own" />;
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="分析"
        description={full ? '売上・顧客・メニュー・スタッフの分析（金額は税込）。' : 'あなたの担当売上・生産性を表示しています。'}
      />
      <FilterBar filters={filters} update={update} />
      <Tabs idBase="analytics" label="分析メニュー" value={tab} onChange={setTab} items={items} />
      <TabPanel idBase="analytics" value={tab}>
        {tab === 'sales' ? <SalesTab f={filters} /> : null}
        {tab === 'customers' ? <CustomersTab f={filters} /> : null}
        {tab === 'repeat' ? <RepeatTab f={filters} /> : null}
        {tab === 'ltv' ? <LtvTab f={filters} /> : null}
        {tab === 'menus' ? <MenusTab f={filters} /> : null}
        {tab === 'staff' ? <StaffTab f={filters} /> : null}
        {tab === 'channels' ? <ChannelsTab f={filters} /> : null}
        {tab === 'ai' ? <AiTab f={filters} /> : null}
      </TabPanel>
    </div>
  );
}
