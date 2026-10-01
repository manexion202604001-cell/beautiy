import { useSearchParams } from 'react-router';
import { Forbidden } from '../../../components/Forbidden';
import { PageHeader, TabPanel, Tabs, type TabItem } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { ReferralLinksTab } from '../marketing/ReferralLinksTab';
import { SnsAssetsTab } from '../marketing/SnsAssetsTab';
import { AutomationsTab } from './AutomationsTab';
import { CampaignsTab } from './CampaignsTab';
import { SegmentsTab } from './SegmentsTab';
import { TemplatesTab } from './TemplatesTab';

type Tab = 'campaigns' | 'segments' | 'templates' | 'automations' | 'referrals' | 'sns';

/** 配信: campaigns, segments, templates, automations + marketing (referral links, SNS material) */
export default function Campaigns() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const campaign = can('campaign.manage');
  const template = can('template.manage') || can('message.send') || campaign;
  const marketing = can('marketing.manage');
  const items: TabItem<Tab>[] = [
    ...(campaign
      ? ([
          { value: 'campaigns', label: 'キャンペーン' },
          { value: 'segments', label: 'セグメント' },
        ] as const)
      : []),
    ...(template ? ([{ value: 'templates', label: 'テンプレート' }] as const) : []),
    ...(campaign ? ([{ value: 'automations', label: '自動配信' }] as const) : []),
    ...(marketing
      ? ([
          { value: 'referrals', label: '紹介リンク' },
          { value: 'sns', label: 'SNS素材' },
        ] as const)
      : []),
  ].map((i) => ({ ...i }));
  const requested = params.get('tab') as Tab | null;
  const tab = items.find((i) => i.value === requested)?.value ?? items[0]?.value;
  if (!tab) return <Forbidden permission="campaign.manage / template.manage / marketing.manage" />;
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
  };
  return (
    <div className="space-y-5">
      <PageHeader title="配信" description="セグメント配信・自動配信・テンプレート・紹介リンク・SNS素材を管理します。" />
      <Tabs idBase="campaigns" label="配信メニュー" value={tab} onChange={setTab} items={items} />
      <TabPanel idBase="campaigns" value={tab}>
        {tab === 'campaigns' ? <CampaignsTab /> : null}
        {tab === 'segments' ? <SegmentsTab /> : null}
        {tab === 'templates' ? <TemplatesTab /> : null}
        {tab === 'automations' ? <AutomationsTab /> : null}
        {tab === 'referrals' ? <ReferralLinksTab /> : null}
        {tab === 'sns' ? <SnsAssetsTab /> : null}
      </TabPanel>
    </div>
  );
}
