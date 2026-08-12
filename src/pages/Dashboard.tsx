import { format } from 'date-fns'
import { ja } from 'date-fns/locale'
import { Link } from 'react-router-dom'
import { Card, EmptyState, SectionLabel, Stat, Tag, yen } from '../components/ui'
import { useStoreVersion } from '../hooks/useStore'
import { listChurnRisk } from '../lib/api/customers'
import { paymentTotal } from '../lib/api/payments'
import { listByDate } from '../lib/api/reservations'
import { menus, payments, staffList, threads } from '../lib/api/store'

/** S-02 ホームダッシュボード */
export function Dashboard() {
  useStoreVersion()
  const today = new Date()
  const todayReservations = listByDate(today).filter((r) => r.status !== 'cancelled')
  const todaySales = payments
    .filter((p) => p.status === 'fixed' && p.fixedAt && new Date(p.fixedAt).toDateString() === today.toDateString())
    .reduce((s, p) => s + paymentTotal(p), 0)
  const unread = threads.reduce((s, t) => s + t.unread, 0)
  const churn = listChurnRisk()
  const staffName = (id: string) => staffList.find((s) => s.id === id)?.name ?? '—'
  const menuName = (ids: string[]) =>
    ids.map((id) => menus.find((m) => m.id === id)?.name ?? '').filter(Boolean).join(' / ')

  return (
    <div>
      <header className="mb-6">
        <p className="text-[11px] uppercase tracking-[0.22em] text-gold">
          {format(today, 'yyyy.MM.dd EEEE', { locale: ja })}
        </p>
        <h1 className="rule-gold mt-1 font-display text-[26px] tracking-wide">本日のサロン</h1>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="本日の予約" value={`${todayReservations.length} 件`} />
        <Stat label="本日売上（確定）" value={yen(todaySales)} />
        <Stat label="未読メッセージ" value={`${unread} 件`} />
        <Stat label="失客リスク" value={`${churn.length} 名`} sub="来店周期 ×1.5 超過" />
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        <section>
          <SectionLabel>本日のご予約</SectionLabel>
          <Card>
            {todayReservations.length === 0 ? (
              <div className="p-4">
                <EmptyState>本日の予約はありません</EmptyState>
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {todayReservations.map((r) => (
                  <li key={r.id}>
                    <Link
                      to={`/reservations/${r.id}`}
                      className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-paper-warm"
                    >
                      <div className="tnum w-[86px] shrink-0 text-[13px] text-ink-soft">
                        {format(new Date(r.start), 'HH:mm')} – {format(new Date(r.end), 'HH:mm')}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px]">{r.customerName}</p>
                        <p className="truncate text-[12px] text-stone">{menuName(r.menuIds)}</p>
                      </div>
                      <div className="hidden text-[12px] text-stone sm:block">{staffName(r.staffId)}</div>
                      <Tag tone={r.nominated ? 'gold' : 'neutral'}>{r.nominated ? '指名' : 'フリー'}</Tag>
                      {r.status === 'tentative' ? <Tag tone="amber">仮予約</Tag> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>

        <section>
          <SectionLabel>アラート</SectionLabel>
          <div className="space-y-3">
            {churn.map((c) => (
              <Card key={c.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[14px]">{c.name} 様</p>
                    <p className="mt-1 text-[12px] leading-relaxed text-stone">
                      最終来店 {c.lastVisit}。来店周期（{c.visitCycleDays}日）を大きく超過しています。
                    </p>
                  </div>
                  <Tag tone="clay">失客リスク</Tag>
                </div>
                <Link
                  to={`/customers/${c.id}`}
                  className="mt-3 inline-block text-[12px] tracking-wide text-gold-deep hover:underline"
                >
                  カルテを開く →
                </Link>
              </Card>
            ))}
            {unread > 0 ? (
              <Card className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[13px] leading-relaxed text-ink-soft">
                    未読のお客様メッセージが {unread} 件あります。
                  </p>
                  <Tag tone="amber">未読</Tag>
                </div>
                <Link to="/messages" className="mt-3 inline-block text-[12px] tracking-wide text-gold-deep hover:underline">
                  メッセージへ →
                </Link>
              </Card>
            ) : null}
            {churn.length === 0 && unread === 0 ? <EmptyState>新しいアラートはありません</EmptyState> : null}
          </div>
        </section>
      </div>
    </div>
  )
}
