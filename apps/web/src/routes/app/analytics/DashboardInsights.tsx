import { Link } from 'react-router';
import { analyticsApi, useReport } from '../../../api/analytics';
import { useOpsDashboard } from '../../../api/ops';
import { StatTile, formatPct } from '../../../components/charts';
import { Alert } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { formatYen } from '../../../lib/format';
import { NextActionsCard } from './AiTab';

/** Dashboard add-on: analytics KPI strip, AI next actions and an ops failure notice (permission-gated) */
export function DashboardInsights() {
  const { can, currentShopId } = useAuth();
  const showKpi = can('analytics.read') && !!currentShopId;
  const showAi = can('ai.use') && can('customer.read');
  const showOps = can('ops.manage');
  if (!showKpi && !showAi && !showOps) return null;
  return (
    <div className="space-y-4">
      {showOps ? <OpsNotice /> : null}
      {showKpi ? <KpiStrip shopId={currentShopId!} /> : null}
      {showAi ? <NextActionsCard shopId={currentShopId ?? undefined} limit={5} compact /> : null}
    </div>
  );
}

function KpiStrip({ shopId }: { shopId: string }) {
  const q = { shopId };
  const r = useReport('dashboard', q, () => analyticsApi.dashboard(q));
  const s = r.data?.shops[0];
  if (!s) return null;
  const m = s.monthToDate;
  return (
    <section aria-label="売上速報" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile label="本日の確定売上" value={formatYen(s.today.completedSales)} sub={`会計 ${s.today.transactions}件 ・見込 ${formatYen(s.today.expectedSales)}`} />
      <StatTile label="今月の売上" value={formatYen(m.sales)} sub={`${m.from.slice(5).replace('-', '/')}〜 来店 ${m.customers}人`} />
      <StatTile
        label="月間目標の達成率"
        value={m.target ? formatPct(m.achievementRate) : '目標未設定'}
        sub={m.target ? `目標 ${formatYen(m.target)} ・残り ${formatYen(m.remainingToTarget)}` : undefined}
      />
      <StatTile
        label="ペース"
        value={m.paceRate === null ? '—' : formatPct(m.paceRate)}
        sub={
          <Link to="/app/analytics" className="text-primary hover:underline">
            分析を開く
          </Link>
        }
      />
    </section>
  );
}

function OpsNotice() {
  const q = useOpsDashboard();
  const d = q.data;
  if (!d) return null;
  const issues = [
    d.webhookEvents.failed + d.webhookEvents.dead ? `Webhook失敗 ${d.webhookEvents.failed + d.webhookEvents.dead}件` : null,
    d.jobs.dead ? `DLQ ${d.jobs.dead}件` : null,
    d.integrations.failing ? `外部連携エラー ${d.integrations.failing}件` : null,
    d.messages.failed ? `送信失敗 ${d.messages.failed}件` : null,
    d.syncConflicts.open ? `未解決の同期競合 ${d.syncConflicts.open}件` : null,
  ].filter(Boolean);
  if (!issues.length) return null;
  return (
    <Alert
      tone="warning"
      title="対応が必要な運用アラートがあります"
      action={
        <Link to="/app/ops" className="shrink-0 text-[13px] font-medium text-primary hover:underline">
          運用・監査を開く
        </Link>
      }
    >
      {issues.join(' ・ ')}
    </Alert>
  );
}
