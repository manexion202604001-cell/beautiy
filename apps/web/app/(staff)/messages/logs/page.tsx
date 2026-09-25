import Link from 'next/link';
import { ScrollText } from 'lucide-react';
import type { Prisma } from '@salonos/db';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { Badge, Card, Empty, PageHeader, Stat } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { MessagesNav } from '../nav';
import { retryAllFailedAction, retryMessageAction } from '../actions';
import { CHANNEL_LABEL, CHANNEL_TONE, STATUS_LABEL, STATUS_SHORT, STATUS_TONE } from '../labels';
import { InlineAction } from '../ui';

export const metadata = { title: '配信ログ' };

const PAGE = 50;
const STATUSES = ['SENT', 'DELIVERED', 'FAILED', 'SKIPPED', 'QUEUED'] as const;
const ORIGINS: Record<string, string> = { manual: '個別送信', broadcast: '一斉配信', automation: '自動配信', system: '予約通知' };

export default async function LogsPage({ searchParams }: { searchParams: Promise<{ status?: string; channel?: string; origin?: string; page?: string }> }) {
  const ctx = await requirePage('message.send');
  const sp = await searchParams;
  const tz = ctx.shop.timezone;
  const status = (STATUSES as readonly string[]).includes(sp.status ?? '') ? sp.status as (typeof STATUSES)[number] : undefined;
  const channel = sp.channel === 'LINE' || sp.channel === 'EMAIL' ? sp.channel : undefined;
  const origin = sp.origin && sp.origin in ORIGINS ? sp.origin : undefined;
  const page = Math.max(1, Math.min(1000, Number(sp.page) || 1));

  const where: Prisma.MessageWhereInput = {
    organizationId: ctx.org.id, direction: 'OUTBOUND',
    ...(status ? { status } : {}), ...(channel ? { channel } : {}),
    ...(origin === 'manual' ? { createdById: { not: null }, broadcastId: null, automationRuleId: null } : {}),
    ...(origin === 'broadcast' ? { broadcastId: { not: null } } : {}),
    ...(origin === 'automation' ? { automationRuleId: { not: null } } : {}),
    ...(origin === 'system' ? { createdById: null, broadcastId: null, automationRuleId: null } : {}),
  };
  const since = new Date(Date.now() - 7 * 86400000);
  const [rows, total, weekly] = await Promise.all([
    prisma.message.findMany({ where, include: { customer: { select: { lastName: true, firstName: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * PAGE, take: PAGE }),
    prisma.message.count({ where }),
    prisma.message.groupBy({ by: ['status'], where: { organizationId: ctx.org.id, direction: 'OUTBOUND', createdAt: { gte: since } }, _count: { _all: true } }),
  ]);
  const w = Object.fromEntries(weekly.map((g) => [g.status, g._count._all])) as Record<string, number>;
  const weekTotal = Object.values(w).reduce((s, n) => s + n, 0);
  const pages = Math.max(1, Math.ceil(total / PAGE));

  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { status, channel, origin, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/messages/logs${s ? `?${s}` : ''}`;
  };

  return (
    <>
      <PageHeader title="メッセージ" sub="送信結果・エラーの確認と再送"
        actions={ctx.can('message.broadcast') && (w.FAILED ?? 0) > 0 ? <InlineAction action={retryAllFailedAction} confirm="直近7日間の失敗メッセージをすべて再送しますか？" className="btn danger-outline">失敗をすべて再送</InlineAction> : undefined} />
      <MessagesNav active="logs" can={{ broadcast: ctx.can('message.broadcast'), automation: ctx.can('message.automation') }} />
      <div className="grid-4" style={{ marginBottom: 16 }}>
        <Stat label="直近7日の送信" value={weekTotal} />
        <Stat label="成功" value={(w.SENT ?? 0) + (w.DELIVERED ?? 0)} sub={weekTotal ? `${Math.round((((w.SENT ?? 0) + (w.DELIVERED ?? 0)) / weekTotal) * 100)}%` : undefined} />
        <Stat label="失敗" value={w.FAILED ?? 0} tone={w.FAILED ? 'down' : undefined} sub={w.FAILED ? <Link className="link" href={qs({ status: 'FAILED', page: undefined })}>失敗のみ表示</Link> : undefined} />
        <Stat label="対象外（停止/連絡先なし）" value={w.SKIPPED ?? 0} />
      </div>
      <div className="msg-filter-bar">
        <div className="seg">
          <Link href={qs({ status: undefined, page: undefined })} className={!status ? 'active' : ''}>すべて</Link>
          {STATUSES.map((s) => <Link key={s} href={qs({ status: s, page: undefined })} className={status === s ? 'active' : ''}>{STATUS_SHORT[s]}</Link>)}
        </div>
        <div className="seg">
          <Link href={qs({ channel: undefined, page: undefined })} className={!channel ? 'active' : ''}>全チャネル</Link>
          <Link href={qs({ channel: 'LINE', page: undefined })} className={channel === 'LINE' ? 'active' : ''}>LINE</Link>
          <Link href={qs({ channel: 'EMAIL', page: undefined })} className={channel === 'EMAIL' ? 'active' : ''}>メール</Link>
        </div>
        <div className="seg">
          <Link href={qs({ origin: undefined, page: undefined })} className={!origin ? 'active' : ''}>全種別</Link>
          {Object.entries(ORIGINS).map(([k, v]) => <Link key={k} href={qs({ origin: k, page: undefined })} className={origin === k ? 'active' : ''}>{v}</Link>)}
        </div>
      </div>
      <Card flush>
        {rows.length === 0 ? (
          <Empty title="該当する送信記録はありません" icon={<ScrollText size={20} />}>{status || channel || origin ? <Link href="/messages/logs" className="link">条件をクリア</Link> : '送信したメッセージの結果がここに表示されます。'}</Empty>
        ) : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>日時</th><th>お客様</th><th>チャネル</th><th className="hide-sm">種別</th><th className="hide-sm">本文</th><th>結果</th><th></th></tr></thead>
            <tbody>
              {rows.map((m) => {
                const o = m.automationRuleId ? 'automation' : m.broadcastId ? 'broadcast' : m.createdById ? 'manual' : 'system';
                return (
                  <tr key={m.id}>
                    <td className="nowrap sub">{fmtDateTime(m.createdAt, tz)}</td>
                    <td className="nowrap"><Link className="link" href={`/messages?customerId=${m.customerId}`}>{m.customer.lastName} {m.customer.firstName}</Link></td>
                    <td><Badge tone={CHANNEL_TONE[m.channel]}>{CHANNEL_LABEL[m.channel]}</Badge></td>
                    <td className="hide-sm sub nowrap">{o === 'broadcast' ? <Link className="link" href={`/messages/broadcasts/${m.broadcastId}`}>{ORIGINS[o]}</Link> : ORIGINS[o]}</td>
                    <td className="hide-sm"><div className="log-body" title={m.body}>{m.body}</div></td>
                    <td>
                      <Badge tone={STATUS_TONE[m.status]}>{STATUS_LABEL[m.status]}</Badge>
                      {m.error && m.error !== 'sandbox' && <div className="sub" style={{ color: m.status === 'FAILED' ? 'var(--red)' : undefined, maxWidth: 260 }}>{m.error}</div>}
                      {m.error === 'sandbox' && <div className="sub">サンドボックス送信</div>}
                    </td>
                    <td className="right">{m.status === 'FAILED' && <InlineAction action={retryMessageAction} fields={{ messageId: m.id }} className="btn danger-outline sm">再送</InlineAction>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </Card>
      {pages > 1 && (
        <div className="between" style={{ marginTop: 12 }}>
          <span className="sub">{total.toLocaleString()}件中 {(page - 1) * PAGE + 1}–{Math.min(total, page * PAGE)}件</span>
          <div className="toolbar">
            {page > 1 && <Link className="btn secondary sm" href={qs({ page: String(page - 1) })}>前へ</Link>}
            {page < pages && <Link className="btn secondary sm" href={qs({ page: String(page + 1) })}>次へ</Link>}
          </div>
        </div>
      )}
    </>
  );
}
