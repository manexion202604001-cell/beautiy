import Link from 'next/link';
import { CalendarClock, MessageCircle, Star, RefreshCw, Inbox } from 'lucide-react';
import { LIFECYCLE_LABEL, addDays, localToUtc, todayIn } from '@salonos/core';
import type { AppointmentStatus } from '@salonos/db';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { PageHeader, Card, Stat, Empty, Badge, type Tone } from '@/components/ui';
import { fmtDate, fmtRange, yen } from '@/lib/format';
import { STATUS_LABEL } from '@/lib/server/booking';
import { customerStats, makePeriod, previousPeriod, recentRepeatRate, resolvePeriod, salesTotals } from '@/lib/server/analytics';
import { Delta } from '../reports/_components/charts';
import { fmtPct, LC_TONE } from '../reports/_components/labels';

export const metadata = { title: 'ダッシュボード' };

const STATUS_TONE: Record<AppointmentStatus, Tone> = { REQUESTED: 'amber', CONFIRMED: 'blue', ARRIVED: 'green', IN_SERVICE: 'violet', COMPLETED: 'gray', CANCELLED: 'red', NO_SHOW: 'red' };
const STATUS_ORDER: AppointmentStatus[] = ['REQUESTED', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requirePage();
  const sp = await searchParams;
  const canOrg = (ctx.role === 'OWNER' || ctx.role === 'DIRECTOR') && ctx.shops.length > 1;
  const orgWide = canOrg && sp.scope === 'org';
  const shopIds = orgWide ? ctx.shops.map((s) => s.id) : [ctx.shop.id];
  const tz = ctx.shop.timezone;
  const now = new Date();
  const today = todayIn(tz, now);
  const dayStart = localToUtc(today, 0, tz), dayEnd = localToUtc(addDays(today, 1), 0, tz);
  const orgId = ctx.org.id;
  const can = { appt: ctx.can('appointment.read'), report: ctx.can('report.read'), customer: ctx.can('customer.read'), msg: ctx.can('message.send'), review: ctx.can('review.reply'), sync: ctx.can('settings.integrations') };

  const mtd = resolvePeriod({ range: 'thisMonth' }, tz, now);
  const [appts, requested, todayTotals, mtdTotals, prevTotals, repeat, followUps, unread, unreplied, syncErrors, setup, staff] = await Promise.all([
    can.appt ? prisma.appointment.findMany({
      where: { organizationId: orgId, shopId: { in: shopIds }, startAt: { gte: dayStart, lt: dayEnd } },
      select: { id: true, shopId: true, startAt: true, endAt: true, status: true, kind: true, title: true, guestName: true, staffId: true, source: true, customer: { select: { id: true, lastName: true, firstName: true } }, menus: { select: { name: true } } },
      orderBy: { startAt: 'asc' }, take: 200,
    }) : Promise.resolve([]),
    can.appt ? prisma.appointment.count({ where: { organizationId: orgId, shopId: { in: shopIds }, status: 'REQUESTED', startAt: { gte: now } } }) : Promise.resolve(0),
    can.report ? salesTotals(orgId, shopIds, makePeriod(today, today, tz, 'today')) : Promise.resolve(null),
    can.report ? salesTotals(orgId, shopIds, mtd) : Promise.resolve(null),
    can.report ? salesTotals(orgId, shopIds, previousPeriod(mtd)) : Promise.resolve(null),
    can.report ? recentRepeatRate(orgId, shopIds, now) : Promise.resolve(null),
    can.customer ? customerStats(orgId, orgWide ? null : ctx.shop.id, now).then((r) => r.filter((c) => c.lifecycle === 'DUE' || c.lifecycle === 'OVERDUE').sort((a, b) => (b.lifecycle === 'OVERDUE' ? 1 : 0) - (a.lifecycle === 'OVERDUE' ? 1 : 0) || b.ltv - a.ltv)) : Promise.resolve([]),
    can.msg ? prisma.message.count({ where: { organizationId: orgId, direction: 'INBOUND', readAt: null, OR: [{ shopId: { in: shopIds } }, { shopId: null }] } }) : Promise.resolve(0),
    can.review ? prisma.review.count({ where: { organizationId: orgId, shopId: { in: shopIds }, reply: null } }) : Promise.resolve(0),
    can.sync ? prisma.syncEvent.count({ where: { organizationId: orgId, status: { in: ['FAILED', 'DEAD', 'CONFLICT'] } } }) : Promise.resolve(0),
    setupStatus(orgId, ctx.shop.id),
    prisma.membership.findMany({ where: { organizationId: orgId }, select: { userId: true, displayName: true } }),
  ]);
  const staffName = new Map(staff.map((s) => [s.userId, s.displayName]));
  const shopName = new Map(ctx.shops.map((s) => [s.id, s.name]));
  const byStatus = STATUS_ORDER.map((s) => ({ s, n: appts.filter((a) => a.status === s).length })).filter((x) => x.n > 0);
  const activeAppts = appts.filter((a) => a.kind !== 'PRIVATE' && a.status !== 'CANCELLED' && a.status !== 'NO_SHOW');
  const setupDone = setup.every((i) => i.done);
  const showSetup = ctx.can('settings.shop') && (sp.welcome === '1' || !setupDone);

  return (
    <>
      <PageHeader
        title={sp.welcome === '1' ? 'ようこそ、MANEXIONへ' : 'ダッシュボード'}
        sub={`${fmtDate(now, tz)} ・ ${orgWide ? `${ctx.org.name}（全${ctx.shops.length}店舗）` : ctx.shop.name}`}
        actions={canOrg ? (
          <div className="seg" role="group" aria-label="表示範囲">
            <Link href="/dashboard" className={orgWide ? '' : 'active'}>{ctx.shop.name}</Link>
            <Link href="/dashboard?scope=org" className={orgWide ? 'active' : ''}>全店舗</Link>
          </div>
        ) : undefined}
      />

      {showSetup && (
        <Card className="section-b" title={setupDone ? '初期設定はすべて完了しています' : `はじめに設定しましょう（${setup.filter((i) => i.done).length}/${setup.length} 完了）`}>
          <ul className="checklist">
            {setup.map((i) => (
              <li key={i.key} className={i.done ? 'done' : ''}>
                <span className="check" aria-hidden="true">{i.done ? '✓' : ''}</span>
                <div className="grow"><b>{i.label}</b><div className="sub">{i.hint}</div></div>
                <Link className={`btn sm ${i.done ? 'ghost' : ''}`} href={i.href}>{i.done ? '確認' : '設定する'}</Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(can.appt || can.report) && (
        <div className="grid-4">
          {can.appt && <Stat label="本日の予約" value={`${activeAppts.length}件`} sub={byStatus.length ? byStatus.map((x) => `${STATUS_LABEL[x.s]} ${x.n}`).join(' / ') : '予約はありません'} />}
          {todayTotals && <Stat label="本日の売上" value={yen(todayTotals.net)} sub={`会計 ${todayTotals.txCount}件 ・ 客単価 ${yen(todayTotals.avgTicket)}`} />}
          {mtdTotals && prevTotals && <Stat label="今月の売上（月初〜本日）" value={yen(mtdTotals.net)} sub={<><Delta cur={mtdTotals.net} prev={prevTotals.net} suffix="前月同期間比" /><div className="sub">前月同期間 {yen(prevTotals.net)}</div></>} />}
          {mtdTotals && <Stat label="今月の客単価" value={yen(mtdTotals.avgTicket)} sub={<Delta cur={mtdTotals.avgTicket} prev={prevTotals?.avgTicket ?? 0} suffix="前月同期間比" />} />}
          {repeat && !can.appt && <Stat label="新規再来率（90日）" value={repeat.cohort ? fmtPct(repeat.rate) : '—'} sub={`対象 ${repeat.cohort}人`} />}
        </div>
      )}

      <div className="grid-auto section">
        {can.appt && <AlertTile href="/reservations" icon={<CalendarClock size={18} />} label="承認待ちの予約" value={requested} tone={requested ? 'amber' : undefined} />}
        {can.msg && <AlertTile href="/messages" icon={<MessageCircle size={18} />} label="未読メッセージ" value={unread} tone={unread ? 'blue' : undefined} />}
        {can.review && <AlertTile href="/reviews" icon={<Star size={18} />} label="未返信の口コミ" value={unreplied} tone={unreplied ? 'amber' : undefined} />}
        {can.sync && <AlertTile href="/settings/sync" icon={<RefreshCw size={18} />} label="外部予約の同期エラー" value={syncErrors} tone={syncErrors ? 'red' : undefined} />}
        {repeat && can.appt && <div className="card stat"><div className="label">新規再来率（90日）</div><div className="value">{repeat.cohort ? fmtPct(repeat.rate) : '—'}</div><div className="sub">90〜180日前に初来店した{repeat.cohort}人のうち</div></div>}
      </div>

      <div className="split section">
        {can.appt ? (
          <Card flush title="本日の予約" actions={<Link className="btn secondary sm" href="/reservations">予約台帳を開く</Link>}>
            {appts.length === 0 ? <Empty title="本日の予約はありません" icon={<Inbox size={20} />}>予約台帳から新しい予約を登録できます。</Empty> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>時間</th><th>お客様</th><th className="hide-sm">メニュー</th><th>担当</th>{orgWide && <th>店舗</th>}<th>状態</th></tr></thead>
                  <tbody>
                    {appts.map((a) => (
                      <tr key={a.id} className={a.status === 'CANCELLED' || a.status === 'NO_SHOW' ? 'row-muted' : ''}>
                        <td className="nowrap num"><Link className="link" href={`/reservations?date=${today}&appointment=${a.id}`}>{fmtRange(a.startAt, a.endAt, tz)}</Link></td>
                        <td>{a.kind === 'PRIVATE' ? <span className="sub">{a.title ?? 'プライベート'}</span> : a.customer ? (can.customer ? <Link className="link" href={`/customers/${a.customer.id}`}>{a.customer.lastName} {a.customer.firstName}</Link> : `${a.customer.lastName} ${a.customer.firstName}`) : a.guestName ?? 'ゲスト'}</td>
                        <td className="sub hide-sm">{a.menus.map((m) => m.name).join('・') || (a.kind === 'CONSULTATION' ? '相談' : '—')}</td>
                        <td className="nowrap">{a.staffId ? staffName.get(a.staffId) ?? '—' : <span className="sub">フリー</span>}</td>
                        {orgWide && <td className="nowrap">{shopName.get(a.shopId)}</td>}
                        <td><Badge tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        ) : <Card><Empty title="予約の閲覧権限がありません" /></Card>}

        {can.customer && (
          <Card title={`フォロー対象（${followUps.length}人）`} actions={can.report ? <Link className="btn ghost sm" href={`/reports/customers?lc=OVERDUE${orgWide ? '&scope=all' : ''}#candidates`}>すべて見る</Link> : undefined}>
            {followUps.length === 0 ? <Empty title="来店周期を過ぎたお客様はいません" /> : (
              <div className="list">
                {followUps.slice(0, 8).map((c) => (
                  <div key={c.id} className="list-item">
                    <div className="grow">
                      <Link className="link" href={`/customers/${c.id}`} style={{ fontWeight: 700 }}>{c.name}</Link>
                      <div className="sub">最終来店 {c.daysSince}日前 ・ 平均 {c.avgIntervalDays === null ? '—' : `${Math.round(c.avgIntervalDays)}日`}周期 ・ LTV {yen(c.ltv)}</div>
                    </div>
                    <Badge tone={LC_TONE[c.lifecycle]}>{LIFECYCLE_LABEL[c.lifecycle]}</Badge>
                    {can.msg && <Link className="btn secondary sm" href={`/messages?customerId=${c.id}`}>連絡</Link>}
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}

function AlertTile({ href, icon, label, value, tone }: { href: string; icon: React.ReactNode; label: string; value: number; tone?: Tone }) {
  return (
    <Link href={href} className="card stat alert-tile">
      <div className="between"><div className="label">{label}</div><span className={`badge ${tone ?? ''}`}>{icon}</span></div>
      <div className="value">{value.toLocaleString('ja-JP')}<span className="sub" style={{ fontSize: 13, marginLeft: 4 }}>件</span></div>
      <div className="sub">{value ? '確認する →' : '対応が必要な項目はありません'}</div>
    </Link>
  );
}

async function setupStatus(orgId: string, shopId: string) {
  const [hours, menus, members, invites, line, appts] = await Promise.all([
    prisma.businessHour.count({ where: { shopId, closed: false } }),
    prisma.menu.count({ where: { shopId, active: true } }),
    prisma.membership.count({ where: { organizationId: orgId } }),
    prisma.invitation.count({ where: { organizationId: orgId } }),
    prisma.integration.count({ where: { organizationId: orgId, provider: 'LINE', configEnc: { not: null } } }),
    prisma.appointment.count({ where: { organizationId: orgId } }),
  ]);
  return [
    { key: 'hours', label: '営業時間・定休日を設定', hint: '予約を受け付ける曜日と時間、臨時休業日を登録します。', done: hours > 0, href: '/settings/hours' },
    { key: 'menus', label: 'メニュー・料金を登録', hint: 'ネット予約とPOSで使うメニューと所要時間を登録します。', done: menus > 0, href: '/settings/menus' },
    { key: 'staff', label: 'スタッフを招待', hint: '招待リンクを送り、役割と担当店舗を割り当てます。', done: members > 1 || invites > 0, href: '/settings/staff' },
    { key: 'line', label: 'LINE公式アカウントを連携', hint: '予約確認やリマインドをLINEで自動送信できます。', done: line > 0, href: '/settings/integrations' },
    { key: 'booking', label: '最初の予約を登録', hint: 'ネット予約ページを共有するか、予約台帳から登録します。', done: appts > 0, href: '/reservations' },
  ];
}
