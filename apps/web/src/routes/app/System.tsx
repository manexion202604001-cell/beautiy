import { ChevronRight } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { MORE_FEATURES } from '../../components/layout/nav';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Tabs,
} from '../../components/shad';
import { useAuth } from '../../lib/auth';
import { AccountCard, OwnerProfileCard } from './system/OwnerTab';
import { PANEL } from './system/shared';
import { StaffTab } from './system/StaffTab';
import { StoresTab } from './system/StoresTab';

type Tab = 'stores' | 'owner' | 'staff' | 'more';

/**
 * 設定 (owner level): 店舗一覧 / オーナー情報 / スタッフ管理, plus その他の機能 — the Salon OS
 * features that have no entry in the main menu. `?tab=` opens a tab directly.
 */
export default function System() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const ownerLevel = can('org.manage');
  const staffAdmin = can('staff.manage');
  const features = MORE_FEATURES.filter((f) => !f.permissions || f.permissions.some((p) => can(p)));

  const items: { value: Tab; label: string }[] = [
    { value: 'stores', label: '店舗一覧' },
    // everyone keeps their own password / two-factor settings here; the business details are the owner's
    { value: 'owner', label: ownerLevel ? 'オーナー情報' : 'アカウント' },
    ...(staffAdmin ? [{ value: 'staff' as const, label: 'スタッフ管理' }] : []),
    ...(features.length ? [{ value: 'more' as const, label: 'その他の機能' }] : []),
  ];
  const requested = params.get('tab') as Tab | null;
  const tab: Tab = items.some((it) => it.value === requested) ? requested! : 'stores';

  return (
    <div className="sy-6">
      <h1 className="text-2xl font-bold">設定</h1>
      <div>
        <Tabs<Tab>
          label="設定"
          value={tab}
          onValueChange={(t) => setParams(t === 'stores' ? {} : { tab: t }, { replace: true })}
          listClassName="flex h-auto w-full flex-wrap gap-1"
          items={items}
        />
        {tab === 'stores' ? (
          <div role="tabpanel" className={PANEL}>
            <StoresTab />
          </div>
        ) : null}
        {tab === 'owner' ? (
          <div role="tabpanel" className={`${PANEL} sy-6`}>
            {ownerLevel ? <OwnerProfileCard /> : null}
            <AccountCard />
          </div>
        ) : null}
        {tab === 'staff' ? (
          <div role="tabpanel" className={`${PANEL} sy-6`}>
            <StaffTab />
          </div>
        ) : null}
        {tab === 'more' ? (
          <div role="tabpanel" className={PANEL}>
            <Card>
              <CardHeader>
                <CardTitle>その他の機能</CardTitle>
                <CardDescription>メニューにない機能はここから開きます</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="sy-4">
                  {features.map((f) => (
                    <Link
                      key={f.to}
                      to={f.to}
                      className="flex items-center justify-between rounded-lg border p-4 transition-colors hover:bg-muted/50"
                    >
                      <div>
                        <div className="font-medium">{f.label}</div>
                        <div className="text-sm text-muted-foreground">{f.description}</div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  );
}
