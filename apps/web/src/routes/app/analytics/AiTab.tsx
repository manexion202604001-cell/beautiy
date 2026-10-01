import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  LEVEL_LABEL,
  aiApi,
  useAtRisk,
  useForecast,
  useNextActions,
  type ChurnLevel,
  type NextAction,
} from '../../../api/ai';
import { ChartCard, LineChart, StatTile, compactYen } from '../../../components/charts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  InlineLoading,
  LoadMore,
  Segmented,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
  useToast,
  type Tone,
} from '../../../components/ui';
import { isApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDate, formatYen } from '../../../lib/format';
import type { AnalyticsFilters } from './filters';

const LEVEL_TONE: Record<ChurnLevel, Tone> = { high: 'danger', medium: 'warning', low: 'neutral' };

function aiDisabled(e: unknown) {
  return isApiError(e) && e.code === 'AI_DISABLED';
}

/** AI insights: churn risk, sales forecast, today's next actions. Proposals only — nothing is sent. */
export function AiTab({ f }: { f: AnalyticsFilters }) {
  const { can, currentShopId } = useAuth();
  const shopId = f.shopId ?? currentShopId ?? undefined;
  const canForecast = can('analytics.read') || can('sales.read');
  return (
    <div className="space-y-5">
      <Alert tone="info" title="AIの提案は送信されません">
        失客リスクや推奨アクションは提案のみです。メッセージは「メッセージ下書き」から内容を確認し、担当者が送信してください。
      </Alert>
      {canForecast && shopId ? <ForecastCard shopId={shopId} /> : null}
      <div className="grid gap-5 xl:grid-cols-[1fr_24rem]">
        {can('customer.read') ? <AtRiskCard shopId={f.shopId} /> : null}
        {can('customer.read') ? <NextActionsCard shopId={f.shopId} /> : null}
      </div>
    </div>
  );
}

function ForecastCard({ shopId }: { shopId: string }) {
  const { shops } = useAuth();
  const [days, setDays] = useState<'14' | '30' | '60'>('30');
  const q = useForecast(shopId, Number(days));
  const d = q.data;
  return (
    <>
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.isLoading ? <InlineLoading /> : null}
      {d ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label={`売上予測（${days}日）`} value={formatYen(d.total.forecast)} sub={`${d.days[0]?.date ?? ''} 〜 ${d.days[d.days.length - 1]?.date ?? ''}`} />
            <StatTile label="予測の幅" value={`${compactYen(d.total.lower)} 〜 ${compactYen(d.total.upper)}`} sub="±1σ（同じ曜日の直近8週）" />
            <StatTile label="予約済み見積" value={formatYen(d.total.booked)} sub="確定前の予約を含む" />
            <StatTile label="学習データ" value={`${d.history.daysWithData}日`} sub={`${d.history.from} 〜 ${d.history.to}`} />
          </div>
          <ChartCard
            title={`売上予測 ・${shops.find((s) => s.id === shopId)?.name ?? d.shopName}`}
            description="曜日別の移動平均と予約済み見積の大きい方を予測値とし、網掛けは信頼帯（±1σ）です。"
            actions={
              <Segmented
                size="sm"
                label="予測日数"
                value={days}
                onChange={setDays}
                options={[
                  { value: '14', label: '14日' },
                  { value: '30', label: '30日' },
                  { value: '60', label: '60日' },
                ]}
              />
            }
            loading={q.isFetching}
            chart={
              <div data-testid="forecast-chart">
                <LineChart
                  ariaLabel="売上予測"
                  labels={d.days.map((x) => x.date)}
                  xFormat={(k) => `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`}
                  tooltipTitle={(k) => formatDate(k)}
                  series={[
                    { key: 'forecast', label: '予測', values: d.days.map((x) => x.forecast) },
                    { key: 'booked', label: '予約済み見積', values: d.days.map((x) => x.bookedAmount), tone: 'muted' },
                  ]}
                  band={{ label: '信頼帯', lower: d.days.map((x) => x.lower), upper: d.days.map((x) => x.upper) }}
                  yFormat={compactYen}
                  valueFormat={formatYen}
                />
              </div>
            }
            table={
              <Table caption="売上予測">
                <THead>
                  <Tr>
                    <Th>日付</Th>
                    <Th className="text-right">予測</Th>
                    <Th className="text-right">下限</Th>
                    <Th className="text-right">上限</Th>
                    <Th className="text-right">予約済み</Th>
                  </Tr>
                </THead>
                <TBody>
                  {d.days.map((x) => (
                    <Tr key={x.date}>
                      <Td>{formatDate(x.date)}</Td>
                      <Td className="text-right tabular">{formatYen(x.forecast)}</Td>
                      <Td className="text-right tabular">{formatYen(x.lower)}</Td>
                      <Td className="text-right tabular">{formatYen(x.upper)}</Td>
                      <Td className="text-right tabular">
                        {formatYen(x.bookedAmount)}（{x.bookedAppointments}件）
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            }
          />
        </>
      ) : null}
    </>
  );
}

function AtRiskCard({ shopId }: { shopId?: string }) {
  const { can, timezone: tz } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [level, setLevel] = useState<'all' | ChurnLevel>('high');
  const q = useAtRisk({ shopId, level: level === 'all' ? undefined : level });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const recompute = useMutation({
    mutationFn: aiApi.recompute,
    onSuccess: () => toast.success('スコアの再計算を受け付けました', '完了まで数分かかることがあります'),
    onError: (e) => toast.error(e),
  });
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-[15px] font-semibold">失客リスクの高い顧客</h2>
          <p className="text-[13px] text-muted">来店周期と最終来店からの経過で毎朝算出（heuristic-v1）</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            size="sm"
            label="リスクレベル"
            value={level}
            onChange={setLevel}
            options={[
              { value: 'high', label: '高' },
              { value: 'medium', label: '中' },
              { value: 'all', label: '中・高' },
            ]}
          />
          {can('ops.manage') ? (
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => recompute.mutate()} loading={recompute.isPending}>
              再計算
            </Button>
          ) : null}
        </div>
      </div>
      {q.isLoading ? <div className="px-5"><InlineLoading /></div> : null}
      {q.error ? (
        aiDisabled(q.error) ? (
          <p className="px-5 py-4 text-[13px] text-muted">この法人ではAIアシストが無効です。</p>
        ) : (
          <ErrorState className="m-4" error={q.error} onRetry={() => void q.refetch()} />
        )
      ) : null}
      {q.data && !items.length ? (
        <EmptyState className="m-4" icon="users" title="該当する顧客はいません" description="スコアは毎朝5:00に更新されます。" />
      ) : null}
      {items.length ? (
        <Table caption="失客リスクの高い顧客" className="rounded-none border-0">
          <THead>
            <Tr>
              <Th>顧客</Th>
              <Th>リスク</Th>
              <Th className="hidden md:table-cell">推奨アクション</Th>
              <Th className="hidden lg:table-cell">次回来店予測</Th>
              <Th className="w-40">
                <span className="sr-only">操作</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {items.map((c) => (
              <Tr key={c.customerId}>
                <Td>
                  <Link to={`/app/customers/${c.customerId}`} className="font-medium text-primary hover:underline">
                    {c.customerName || '（氏名未登録）'}
                  </Link>
                  <p className="text-xs text-subtle">
                    最終来店 {c.lastVisitAt ? formatDate(c.lastVisitAt, tz, { weekday: false }) : '—'} ・{c.visitCount}回
                    {!c.marketingOptIn ? ' ・配信拒否' : ''}
                  </p>
                </Td>
                <Td>
                  <Badge tone={LEVEL_TONE[c.level]}>
                    {LEVEL_LABEL[c.level]} {Math.round(c.churnRisk * 100)}%
                  </Badge>
                </Td>
                <Td className="hidden max-w-xs md:table-cell">
                  <p className="text-xs text-fg">{c.recommendedAction ?? '—'}</p>
                </Td>
                <Td className="hidden lg:table-cell text-xs">
                  {c.predictedNextVisit ? formatDate(c.predictedNextVisit, tz, { weekday: false }) : '—'}
                </Td>
                <Td>
                  {can('message.send') && can('ai.use') ? (
                    <Button
                      size="xs"
                      variant="soft"
                      icon="sparkle"
                      onClick={() => navigate(`/app/messages?customer=${c.customerId}&draft=dormant`)}
                    >
                      メッセージ下書き
                    </Button>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : null}
      <LoadMore hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
    </Card>
  );
}

const ACTION_LABEL: Record<NextAction['type'], string> = {
  churn_risk: '休眠フォロー',
  second_visit: '2回目来店フォロー',
  birthday: 'お誕生日',
};
const ACTION_TONE: Record<NextAction['type'], Tone> = { churn_risk: 'danger', second_visit: 'info', birthday: 'primary' };

export function NextActionsCard({ shopId, limit = 20, compact }: { shopId?: string; limit?: number; compact?: boolean }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const q = useNextActions(shopId, limit);
  // the API can list the same customer under several reasons (e.g. churn_risk + second_visit) → keep the top one
  const seen = new Set<string>();
  const actions = (q.data?.items ?? []).filter((a) => !seen.has(a.customerId) && !!seen.add(a.customerId));
  return (
    <Card>
      <CardHeader
        title="今日のおすすめアクション"
        description={q.data ? `休眠 ${q.data.counts.churnRisk} ・2回目 ${q.data.counts.secondVisit} ・誕生日 ${q.data.counts.birthday}` : 'AIが優先度順に提案します'}
      />
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? (
        aiDisabled(q.error) ? (
          <p className="text-[13px] text-muted">この法人ではAIアシストが無効です。</p>
        ) : (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        )
      ) : null}
      {q.data && !actions.length ? <p className="text-[13px] text-muted">本日のおすすめはありません。</p> : null}
      <ul className="divide-y divide-border" data-testid="next-actions">
        {actions.slice(0, compact ? 5 : limit).map((a) => (
          <li key={`${a.type}-${a.customerId}`} className="flex items-start gap-3 py-2.5">
            <Badge size="sm" tone={ACTION_TONE[a.type]} className="mt-0.5">
              {ACTION_LABEL[a.type]}
            </Badge>
            <div className="min-w-0 flex-1">
              <Link to={`/app/customers/${a.customerId}`} className="text-[13px] font-medium hover:underline">
                {a.customerName || '（氏名未登録）'}
              </Link>
              <p className="text-xs text-muted">{a.reason}</p>
            </div>
            {can('message.send') && can('ai.use') ? (
              <Button
                size="xs"
                variant="ghost"
                icon="message"
                onClick={() => navigate(`/app/messages?customer=${a.customerId}&draft=${a.suggestedPurpose}`)}
              >
                下書き
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {q.data ? <p className="mt-2 text-[11px] text-subtle">{q.data.note}</p> : null}
    </Card>
  );
}
