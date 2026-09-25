import Link from 'next/link';
import { Send } from 'lucide-react';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { broadcastStatusCounts, normalizeSegment } from '@/lib/server/messaging';
import { Badge, Card, Empty, PageHeader, Stat } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { MessagesNav } from '../nav';
import { BROADCAST_STATUS, CHANNEL_LABEL } from '../labels';
import { describeSegment } from './segment-label';
import { segmentMaps } from './data';

export const metadata = { title: '一斉配信' };

const FILTERS = [['', 'すべて'], ['DRAFT', '下書き'], ['SCHEDULED', '予約配信'], ['SENDING', '送信中'], ['SENT', '送信完了']] as const;

export default async function BroadcastsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await requirePage('message.broadcast');
  const sp = await searchParams;
  const status = FILTERS.some(([k]) => k === sp.status) ? sp.status : '';
  const tz = ctx.shop.timezone;
  const [list, maps, monthSent] = await Promise.all([
    prisma.broadcast.findMany({ where: { organizationId: ctx.org.id, ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 }),
    segmentMaps(ctx.org.id, ctx),
    prisma.message.count({ where: { organizationId: ctx.org.id, broadcastId: { not: null }, status: { in: ['SENT', 'DELIVERED'] }, createdAt: { gte: new Date(Date.now() - 30 * 86400000) } } }),
  ]);
  const counts = await broadcastStatusCounts(ctx.org.id, list.map((b) => b.id));
  const scheduled = list.filter((b) => b.status === 'SCHEDULED').length;

  return (
    <>
      <PageHeader title="メッセージ" sub="セグメントを指定してLINE・メールを一斉配信" actions={<Link href="/messages/broadcasts/new" className="btn">＋ 新規配信を作成</Link>} />
      <MessagesNav active="broadcasts" can={{ broadcast: true, automation: ctx.can('message.automation') }} />
      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat label="配信数（直近30日・成功）" value={`${monthSent.toLocaleString()}通`} />
        <Stat label="予約中の配信" value={`${scheduled}件`} />
        <Stat label="作成済みの配信" value={`${list.length}件`} sub={status ? 'フィルタ適用中' : undefined} />
      </div>
      <div className="seg" style={{ marginBottom: 12 }}>
        {FILTERS.map(([k, v]) => <Link key={k} href={k ? `/messages/broadcasts?status=${k}` : '/messages/broadcasts'} className={status === k ? 'active' : ''}>{v}</Link>)}
      </div>
      {list.length === 0 ? (
        <Card><Empty title="配信はまだありません" icon={<Send size={20} />} action={<Link href="/messages/broadcasts/new" className="btn">配信を作成</Link>}>
          タグや最終来店日で対象を絞り込み、キャンペーンやお知らせを一斉に届けられます。
        </Empty></Card>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>配信名</th><th>状態</th><th className="hide-sm">対象</th><th>日時</th><th className="num">送信</th><th className="num">失敗</th><th className="num hide-sm">対象外</th></tr></thead>
            <tbody>
              {list.map((b) => {
                const c = counts.get(b.id) ?? {};
                const st = BROADCAST_STATUS[b.status] ?? { label: b.status, tone: 'gray' as const };
                return (
                  <tr key={b.id}>
                    <td><Link href={`/messages/broadcasts/${b.id}`} className="link"><strong>{b.name}</strong></Link><div className="sub">{CHANNEL_LABEL[b.channel]} · {b.body.slice(0, 40)}{b.body.length > 40 ? '…' : ''}</div></td>
                    <td><Badge tone={st.tone}>{st.label}</Badge></td>
                    <td className="hide-sm sub">{describeSegment(normalizeSegment(b.segment), maps).join(' / ')}</td>
                    <td className="nowrap sub">{b.sentAt ? `送信 ${fmtDateTime(b.sentAt, tz)}` : b.scheduledAt ? `予約 ${fmtDateTime(b.scheduledAt, tz)}` : `作成 ${fmtDateTime(b.createdAt, tz)}`}</td>
                    <td className="num">{(c.SENT ?? 0) + (c.DELIVERED ?? 0)}</td>
                    <td className="num">{c.FAILED ? <span style={{ color: 'var(--red)', fontWeight: 700 }}>{c.FAILED}</span> : 0}</td>
                    <td className="num hide-sm">{c.SKIPPED ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
