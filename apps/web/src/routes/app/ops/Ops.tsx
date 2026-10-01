import { useSearchParams } from 'react-router';
import { Forbidden } from '../../../components/Forbidden';
import { PageHeader, TabPanel, Tabs, type TabItem } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { AuditTab, ExportsTab, FlagsTab } from './AuditExportFlags';
import { HealthTab, JobsTab, OpsDashboardTab, WebhooksTab } from './OpsTabs';

type Tab = 'dashboard' | 'jobs' | 'webhooks' | 'health' | 'audit' | 'exports' | 'flags';

/** 運用・監査 (O-01〜O-07) */
export default function Ops() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const ops = can('ops.manage');
  const items: TabItem<Tab>[] = [
    ...(ops
      ? [
          { value: 'dashboard' as const, label: '障害ダッシュボード' },
          { value: 'jobs' as const, label: 'ジョブ・DLQ' },
          { value: 'webhooks' as const, label: 'Webhook' },
          { value: 'health' as const, label: 'ヘルス' },
        ]
      : []),
    ...(can('audit.read') ? [{ value: 'audit' as const, label: '監査ログ' }] : []),
    ...(can('export.data') || can('audit.read') ? [{ value: 'exports' as const, label: 'データエクスポート' }] : []),
    ...(ops ? [{ value: 'flags' as const, label: '機能フラグ' }] : []),
  ];
  const requested = params.get('tab') as Tab | null;
  const tab = items.find((i) => i.value === requested)?.value ?? items[0]?.value;
  if (!tab) return <Forbidden permission="ops.manage / audit.read / export.data" />;
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
  };
  return (
    <div className="space-y-5">
      <PageHeader title="運用・監査" description="障害の確認と再処理、監査ログ、データエクスポート、機能フラグを管理します。" />
      <Tabs idBase="ops" label="運用メニュー" value={tab} onChange={setTab} items={items} />
      <TabPanel idBase="ops" value={tab}>
        {tab === 'dashboard' ? <OpsDashboardTab onOpen={setTab} /> : null}
        {tab === 'jobs' ? <JobsTab /> : null}
        {tab === 'webhooks' ? <WebhooksTab /> : null}
        {tab === 'health' ? <HealthTab /> : null}
        {tab === 'audit' ? <AuditTab /> : null}
        {tab === 'exports' ? <ExportsTab /> : null}
        {tab === 'flags' ? <FlagsTab /> : null}
      </TabPanel>
    </div>
  );
}
