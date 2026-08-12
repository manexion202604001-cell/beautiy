import { format } from 'date-fns'
import { ja } from 'date-fns/locale'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button, Card, PageHeader, Tag, yen } from '../components/ui'
import { useStoreVersion } from '../hooks/useStore'
import { getCustomer } from '../lib/api/customers'
import { getReservation, updateStatus } from '../lib/api/reservations'
import { menus, staffList } from '../lib/api/store'

/** S-04 予約詳細 */
export function ReservationDetail() {
  useStoreVersion()
  const { id } = useParams()
  const navigate = useNavigate()
  const reservation = id ? getReservation(id) : undefined
  if (!reservation) {
    return <p className="text-stone">予約が見つかりません。</p>
  }
  const staff = staffList.find((s) => s.id === reservation.staffId)
  const customer = reservation.customerId ? getCustomer(reservation.customerId) : undefined
  const items = reservation.menuIds.map((mid) => menus.find((m) => m.id === mid)).filter((m) => m !== undefined)
  const total = items.reduce((s, m) => s + m.price, 0)

  const statusTag = {
    confirmed: <Tag tone="sage">確定</Tag>,
    tentative: <Tag tone="amber">仮予約</Tag>,
    done: <Tag tone="gold">来店済</Tag>,
    cancelled: <Tag tone="clay">キャンセル</Tag>,
    no_show: <Tag tone="clay">無断キャンセル</Tag>,
  }[reservation.status]

  return (
    <div className="max-w-2xl">
      <PageHeader eyebrow="Reservations" title="予約詳細" action={statusTag} />
      <Card className="p-6">
        <dl className="grid gap-x-8 gap-y-4 text-[14px] sm:grid-cols-2">
          <Item label="お客様">
            <span className="flex items-center gap-2">
              {reservation.customerName}
              {customer?.warnings.length ? <Tag tone="clay">警告あり</Tag> : null}
            </span>
          </Item>
          <Item label="担当">{staff?.name ?? '—'}（{reservation.nominated ? '指名' : 'フリー'}）</Item>
          <Item label="日時">
            {format(new Date(reservation.start), 'yyyy年M月d日（E） HH:mm', { locale: ja })} –{' '}
            {format(new Date(reservation.end), 'HH:mm')}
          </Item>
          <Item label="経路">{sourceLabel(reservation.source)}</Item>
          <Item label="メニュー">
            <ul className="space-y-1">
              {items.map((m) => (
                <li key={m.id} className="flex justify-between gap-6">
                  <span>{m.name}</span>
                  <span className="tnum text-ink-soft">{yen(m.price)}</span>
                </li>
              ))}
              <li className="flex justify-between gap-6 border-t border-line pt-1.5 text-ink">
                <span>合計（税込）</span>
                <span className="tnum">{yen(total)}</span>
              </li>
            </ul>
          </Item>
          {reservation.note ? <Item label="申し送り">{reservation.note}</Item> : null}
        </dl>

        <div className="mt-6 flex flex-wrap gap-3 border-t border-line pt-5">
          {customer ? (
            <Link to={`/customers/${customer.id}`}>
              <Button variant="ghost">カルテを開く</Button>
            </Link>
          ) : null}
          {reservation.status === 'tentative' ? (
            <Button onClick={() => updateStatus(reservation.id, 'confirmed')}>予約を確定</Button>
          ) : null}
          {reservation.status === 'confirmed' ? (
            <Button onClick={() => updateStatus(reservation.id, 'done')}>来店済みにする</Button>
          ) : null}
          {reservation.status !== 'cancelled' && reservation.status !== 'done' ? (
            <Button variant="danger" onClick={() => updateStatus(reservation.id, 'cancelled')}>
              キャンセル
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => navigate(-1)}>
            戻る
          </Button>
        </div>
      </Card>
    </div>
  )
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="mb-1 text-[11px] uppercase tracking-[0.18em] text-stone">{label}</dt>
      <dd className="leading-relaxed">{children}</dd>
    </div>
  )
}

function sourceLabel(source: string): string {
  return (
    { app: 'スタッフ登録', web: 'Web予約', line: 'LINE', phone: '電話', external: '外部サイト' }[source] ?? source
  )
}
