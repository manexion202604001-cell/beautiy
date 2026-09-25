import Link from 'next/link';
import type { Prisma, SyncStatus } from '@salonos/db';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { PageHeader, Card, Badge, Empty } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { BOOKING_PROVIDERS, SYNC_STATUS_LABEL, type StoredNormalized } from '@/lib/server/sync';
import { displayEventId, PROBLEM, providerLabel, SYNC_TONE } from './labels';

export const metadata = { title: '外部予約の同期状況' };

const PAGE = 30;
const FILTERS: { key: string; label: string; statuses?: SyncStatus[] }[] = [
  { key: 'problem', label: '要対応', statuses: PROBLEM },
  { key: 'CONFLICT', label: '競合', statuses: ['CONFLICT'] },
  { key: 'FAILED', label: '再試行待ち', statuses: ['FAILED'] },
  { key: 'DEAD', label: '失敗（停止）', statuses: ['DEAD'] },
  { key: 'PENDING', label: '待機・処理中', statuses: ['PENDING', 'PROCESSING'] },
  { key: 'DONE', label: '完了', statuses: ['DONE'] },
  { key: 'all', label: 'すべて' },
];

export default async function SyncPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requirePage('settings.integrations');
  const sp = await searchParams;
  const orgId = ctx.org.id;
  const filter = FILTERS.find((f) => f.key === sp.status) ?? FILTERS[0];
  const provider = sp.provider && /^[A-Z_]{2,20}$/.test(sp.provider) ? sp.provider : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const since = new Date(Date.now() - 7 * 86400000);
  const where: Prisma.SyncEventWhereInput = { organizationId: orgId, ...(filter.statuses ? { status: { in: filter.statuses } } : {}), ...(provider ? { provider } : {}) };

  const [integrations, stats, lastDone, events, count, problemCount] = await Promise.all([
    prisma.integration.findMany({ where: { organizationId: orgId, provider: { in: [...BOOKING_PROVIDERS] } }, orderBy: { createdAt: 'asc' } }),
    prisma.syncEvent.groupBy({ by: ['provider', 'integrationId', 'status'], where: { organizationId: orgId, createdAt: { gte: since } }, _count: true }),
    prisma.syncEvent.groupBy({ by: ['integrationId'], where: { organizationId: orgId, status: 'DONE' }, _max: { processedAt: true } }),
    prisma.syncEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * PAGE, take: PAGE }),
    prisma.syncEvent.count({ where }),
    prisma.syncEvent.count({ where: { organizationId: orgId, status: { in: PROBLEM } } }),
  ]);
  const shops = new Map(ctx.shops.map((s) => [s.id, s.name]));
  const tz = ctx.shop.timezone;
  const pages = Math.max(1, Math.ceil(count / PAGE));
  const href = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    const merged = { status: filter.key, provider, page: undefined as string | undefined, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) u.set(k, v);
    return `/settings/sync?${u}`;
  };
  // Health rows: each integration, plus orphan provider buckets (events without an integration row)
  const orphanProviders = [...new Set(stats.filter((s) => !s.integrationId || !integrations.some((i) => i.id === s.integrationId)).map((s) => s.provider))];

  const health = [
    ...integrations.map((it) => ({ key: it.id, provider: it.provider, scope: it.shopId ? shops.get(it.shopId) ?? '（他店舗）' : '全店舗共通', status: it.status, lastError: it.lastError, lastSync: it.lastSyncAt ?? lastDone.find((l) => l.integrationId === it.id)?._max.processedAt ?? null, rows: stats.filter((s) => s.integrationId === it.id) })),
    ...orphanProviders.map((p) => ({ key: `orphan-${p}`, provider: p, scope: '連携設定なし', status: 'UNKNOWN', lastError: null as string | null, lastSync: null as Date | null, rows: stats.filter((s) => s.provider === p && (!s.integrationId || !integrations.some((i) => i.id === s.integrationId))) })),
  ];

  return (
    <>
      <PageHeader title="外部予約の同期状況" back={{ href: '/settings', label: '設定' }} sub="外部予約サイトから受信した予約の処理状況です。失敗は自動で再試行され（最大6回・間隔を延ばしながら）、競合は手動で解消します。" actions={<Link className="btn secondary" href="/settings/integrations">連携設定</Link>} />

      <h2 style={{ margin: '0 0 10px' }}>連携ごとの状態（直近7日）</h2>
      {health.length === 0 ? (
        <Card><Empty title="外部予約サイトの連携はまだありません" action={<Link className="btn" href="/settings/integrations">連携を追加する</Link>}>予約サイトからの予約を自動で取り込むには、外部連携で予約サイトを追加してください。</Empty></Card>
      ) : (
        <div className="grid-3">
          {health.map((h) => {
            const total = h.rows.reduce((a, r) => a + r._count, 0);
            const by = (s: SyncStatus[]) => h.rows.filter((r) => s.includes(r.status)).reduce((a, r) => a + r._count, 0);
            const bad = by(PROBLEM);
            const rate = total ? bad / total : 0;
            return (
              <div key={h.key} className="card">
                <div className="between"><b>{providerLabel(h.provider)}</b>{h.status === 'PAUSED' ? <Badge>一時停止</Badge> : h.status === 'UNKNOWN' ? <Badge tone="amber">設定なし</Badge> : rate > 0.2 ? <Badge tone="red">要確認</Badge> : <Badge tone="green">正常</Badge>}</div>
                <div className="sub">{h.scope}</div>
                <div className="kpi-mini" style={{ marginTop: 10 }}>
                  <div><span className="sub">受信</span><b>{total}</b></div>
                  <div><span className="sub">完了</span><b>{by(['DONE'])}</b></div>
                  <div><span className="sub">要対応</span><b style={{ color: bad ? 'var(--red)' : undefined }}>{bad}</b></div>
                  <div><span className="sub">失敗率</span><b>{total ? `${(rate * 100).toFixed(0)}%` : '—'}</b></div>
                </div>
                <div className="sub" style={{ marginTop: 8 }}>最終成功：{h.lastSync ? fmtDateTime(h.lastSync, tz) : '—'}</div>
                {h.lastError && <div className="sub" style={{ color: 'var(--red)' }}>直近のエラー：{h.lastError}</div>}
              </div>
            );
          })}
        </div>
      )}

      <Card className="section" flush title={<h2>イベント {problemCount > 0 && <Badge tone="red">要対応 {problemCount}件</Badge>}</h2>}>
        <div className="report-filters" style={{ padding: '0 18px', marginTop: 10 }}>
          <div className="seg" role="group" aria-label="状態で絞り込み">
            {FILTERS.map((f) => <Link key={f.key} href={href({ status: f.key })} className={f.key === filter.key ? 'active' : ''}>{f.label}</Link>)}
          </div>
          <form method="get" action="/settings/sync" className="row">
            <input type="hidden" name="status" value={filter.key} />
            <label className="sr-only" htmlFor="sync-prov">連携先</label>
            <select id="sync-prov" name="provider" className="select sm" defaultValue={provider ?? ''} style={{ width: 'auto' }}>
              <option value="">すべての連携先</option>
              {BOOKING_PROVIDERS.map((p) => <option key={p} value={p}>{providerLabel(p)}</option>)}
            </select>
            <button className="btn secondary sm" type="submit">絞り込み</button>
          </form>
        </div>
        {events.length === 0 ? <Empty title={filter.key === 'problem' ? '対応が必要なイベントはありません' : '該当するイベントはありません'} /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>受信日時</th><th>連携先</th><th>予約</th><th>予約日時</th><th>状態</th><th className="num">試行</th><th>エラー・結果</th><th /></tr></thead>
              <tbody>
                {events.map((e) => {
                  const n = e.normalized as unknown as StoredNormalized | null;
                  const b = n?.bookings?.[0];
                  return (
                    <tr key={e.id}>
                      <td className="nowrap">{fmtDateTime(e.createdAt, tz)}<div className="sub">{e.direction === 'OUTBOUND' ? '送信' : '受信'}</div></td>
                      <td className="nowrap">{providerLabel(e.provider)}</td>
                      <td>{b ? <><span className="mono">{b.externalId}</span>{b.status === 'cancelled' && <> <Badge tone="red">キャンセル</Badge></>}<div className="sub">{b.customer?.name}</div></> : <span className="sub mono">{displayEventId(e.externalEventId, e.integrationId).slice(0, 40)}</span>}</td>
                      <td className="nowrap">{b ? fmtDateTime(b.startAt, tz) : '—'}</td>
                      <td><Badge tone={SYNC_TONE[e.status]}>{SYNC_STATUS_LABEL[e.status]}</Badge></td>
                      <td className="num">{e.attempts}</td>
                      <td style={{ maxWidth: 320 }}>{e.lastError ? <span className="sub" style={{ color: e.status === 'DONE' ? undefined : 'var(--red)' }}>{e.lastError}</span> : e.status === 'FAILED' ? <span className="sub">次回 {fmtDateTime(e.nextAttemptAt, tz)}</span> : <span className="sub">—</span>}</td>
                      <td className="right"><Link className="btn secondary sm" href={`/settings/sync/${e.id}`}>{e.status === 'CONFLICT' ? '解消する' : '詳細'}</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="between" style={{ padding: '10px 16px' }}>
            <span className="sub">{count}件中 {(page - 1) * PAGE + 1}–{Math.min(count, page * PAGE)}件</span>
            <div className="row">
              {page > 1 && <Link className="btn secondary sm" href={href({ page: String(page - 1) })}>前へ</Link>}
              {page < pages && <Link className="btn secondary sm" href={href({ page: String(page + 1) })}>次へ</Link>}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
