import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { broadcastStatusCounts, normalizeSegment } from '@/lib/server/messaging';
import { Badge, Card, Empty, PageHeader, Stat } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { BroadcastBuilder } from '../BroadcastBuilder';
import { builderOptions, segmentMaps, toLocalInput } from '../data';
import { describeSegment } from '../segment-label';
import { BROADCAST_STATUS, CHANNEL_LABEL, STATUS_SHORT, STATUS_TONE } from '../../labels';
import { InlineAction } from '../../ui';
import { deleteBroadcastAction, duplicateBroadcastAction, resumeBroadcastAction, retryMessageAction, unscheduleBroadcastAction } from '../../actions';
import { NavAction } from './NavAction';

export const metadata = { title: '一斉配信' };

export default async function BroadcastDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ status?: string }> }) {
  const ctx = await requirePage('message.broadcast');
  const { id } = await params;
  const sp = await searchParams;
  const b = await prisma.broadcast.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!b) notFound();
  const tz = ctx.shop.timezone;
  const st = BROADCAST_STATUS[b.status] ?? { label: b.status, tone: 'gray' as const };
  const segment = normalizeSegment(b.segment);
  const maps = await segmentMaps(ctx.org.id, ctx);
  const header = (
    <PageHeader
      title={<span className="row-wrap">{b.name} <Badge tone={st.tone}>{st.label}</Badge></span>}
      back={{ href: '/messages/broadcasts', label: '一斉配信' }}
      sub={`${CHANNEL_LABEL[b.channel]} · 対象：${describeSegment(segment, maps).join(' / ')}`}
      actions={<>
        <NavAction fields={{ id: b.id }} action={duplicateBroadcastAction} label="複製" to={{ prefix: '/messages/broadcasts/' }} />
        {b.status === 'SCHEDULED' && <InlineAction action={unscheduleBroadcastAction} fields={{ id: b.id }} confirm="配信予約を取り消して下書きに戻しますか？">予約を取り消す</InlineAction>}
        {(b.status === 'DRAFT' || b.status === 'SCHEDULED') && <DeleteAndBack id={b.id} />}
        {b.status === 'SENDING' && <InlineAction action={resumeBroadcastAction} fields={{ id: b.id }} confirm="未送信のお客様への配信を再開しますか？（送信済みの方には送られません）" className="btn sm">送信を再開</InlineAction>}
      </>}
    />
  );

  if (b.status === 'DRAFT' || b.status === 'SCHEDULED') {
    const opts = await builderOptions(ctx);
    return (
      <>
        {header}
        {b.status === 'SCHEDULED' && b.scheduledAt && <div className="alert info" style={{ marginBottom: 14 }}>{fmtDateTime(b.scheduledAt, tz)} に配信予定です。内容を変更して「配信を予約」で更新できます。</div>}
        <BroadcastBuilder {...opts} initial={{ id: b.id, name: b.name, body: b.body, channel: b.channel === 'EMAIL' ? 'EMAIL' : 'LINE', segment, scheduledAtLocal: b.scheduledAt ? toLocalInput(b.scheduledAt, tz) : null }} />
      </>
    );
  }

  const counts = (await broadcastStatusCounts(ctx.org.id, [b.id])).get(b.id) ?? {};
  const filter = sp.status && sp.status in STATUS_SHORT ? sp.status : undefined;
  const messages = await prisma.message.findMany({
    where: { organizationId: ctx.org.id, broadcastId: b.id, ...(filter ? { status: filter as any } : {}) },
    include: { customer: { select: { id: true, lastName: true, firstName: true } } }, orderBy: { createdAt: 'asc' }, take: 500,
  });
  const sent = (counts.SENT ?? 0) + (counts.DELIVERED ?? 0);
  return (
    <>
      {header}
      <div className="grid-4" style={{ marginBottom: 16 }}>
        <Stat label="配信対象" value={`${b.recipientCount || Object.values(counts).reduce((s, n) => s + n, 0)}人`} sub={b.sentAt ? `完了 ${fmtDateTime(b.sentAt, tz)}` : '送信中'} />
        <Stat label="送信成功" value={sent} />
        <Stat label="失敗" value={counts.FAILED ?? 0} tone={counts.FAILED ? 'down' : undefined} sub={counts.FAILED ? '下の一覧から再送できます' : undefined} />
        <Stat label="対象外（停止/連絡先なし）" value={counts.SKIPPED ?? 0} />
      </div>
      <div className="split">
        <Card title="送信結果" flush actions={
          <div className="seg">
            <Link href={`/messages/broadcasts/${b.id}`} className={!filter ? 'active' : ''}>すべて</Link>
            {['SENT', 'FAILED', 'SKIPPED'].map((s) => <Link key={s} href={`/messages/broadcasts/${b.id}?status=${s}`} className={filter === s ? 'active' : ''}>{STATUS_SHORT[s]}</Link>)}
          </div>
        }>
          {messages.length === 0 ? <Empty title="該当する送信結果はありません" /> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>お客様</th><th>状態</th><th className="hide-sm">送信日時</th><th></th></tr></thead>
              <tbody>{messages.map((m) => (
                <tr key={m.id}>
                  <td><Link className="link" href={`/messages?customerId=${m.customerId}`}>{m.customer.lastName} {m.customer.firstName}</Link></td>
                  <td><Badge tone={STATUS_TONE[m.status]}>{STATUS_SHORT[m.status]}</Badge>{m.error && m.error !== 'sandbox' && <div className="sub" style={{ color: m.status === 'FAILED' ? 'var(--red)' : undefined }}>{m.error}</div>}</td>
                  <td className="hide-sm sub nowrap">{fmtDateTime(m.sentAt ?? m.createdAt, tz)}</td>
                  <td className="right">{m.status === 'FAILED' && <InlineAction action={retryMessageAction} fields={{ messageId: m.id }} className="btn danger-outline sm">再送</InlineAction>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        <Card title="配信本文">
          <div className="chat"><div className="bubble out">{b.body}</div></div>
          <p className="sub" style={{ marginTop: 10 }}>変数はお客様ごとに差し込まれて送信されました。</p>
        </Card>
      </div>
    </>
  );
}

function DeleteAndBack({ id }: { id: string }) {
  return <NavAction action={deleteBroadcastAction} fields={{ id }} confirm="この配信を削除しますか？" className="btn danger-outline sm" label="削除" to={{ href: '/messages/broadcasts' }} />;
}
