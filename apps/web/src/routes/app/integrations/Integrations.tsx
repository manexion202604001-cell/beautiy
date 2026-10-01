import { useSearchParams } from 'react-router';
import { useSyncStatus } from '../../../api/integrations';
import { Forbidden } from '../../../components/Forbidden';
import { PageHeader, TabPanel, Tabs } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { AccountsTab } from './AccountsTab';
import { ConflictsTab, StatusTab } from './ConflictsTab';
import { LineChannelsTab } from './LineChannelsTab';
import { ManualBlockList } from './MailTools';

type Tab = 'accounts' | 'manual' | 'status' | 'conflicts' | 'line';

/** 外部連携 (S-95 / S-56 / O-04): booking media, sync status, conflict queue, LINE channels */
export default function Integrations() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const allowed = can('integration.manage');
  const status = useSyncStatus(allowed);
  if (!allowed) return <Forbidden permission="integration.manage" />;
  const open = status.data?.shops.reduce((s, x) => s + x.openConflicts, 0) ?? undefined;
  const accounts = status.data?.shops.flatMap((s) => s.accounts) ?? [];
  const manual = accounts.reduce((s, a) => s + (a.manualActionRequired ?? 0), 0);
  const hasManual = accounts.some((a) => a.provider === 'hotpepper_mail' || a.provider === 'lime_mail');
  const tabs: { value: Tab; label: string; count?: number }[] = [
    { value: 'accounts', label: '予約媒体' },
    ...(hasManual || manual ? [{ value: 'manual' as Tab, label: '媒体の枠止め', count: manual || undefined }] : []),
    { value: 'status', label: '同期ステータス' },
    { value: 'conflicts', label: '競合キュー', count: open || undefined },
    { value: 'line', label: 'LINE公式アカウント' },
  ];
  const requested = params.get('tab') as Tab | null;
  const tab = tabs.find((t) => t.value === requested)?.value ?? 'accounts';
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
  };
  return (
    <div className="space-y-5">
      <PageHeader title="外部連携" description="予約媒体（ホットペッパー・LiME など）との同期・枠止め・競合の解決、LINE公式アカウントの設定を行います。" />
      <Tabs idBase="integrations" label="外部連携メニュー" value={tab} onChange={setTab} items={tabs} />
      <TabPanel idBase="integrations" value={tab}>
        {tab === 'accounts' ? <AccountsTab /> : null}
        {tab === 'manual' ? <ManualBlockList /> : null}
        {tab === 'status' ? <StatusTab /> : null}
        {tab === 'conflicts' ? <ConflictsTab /> : null}
        {tab === 'line' ? <LineChannelsTab /> : null}
      </TabPanel>
    </div>
  );
}
