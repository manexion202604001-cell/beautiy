import { format } from 'date-fns'
import { ja } from 'date-fns/locale'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button, Card, PageHeader, SectionLabel, Tag, yen } from '../components/ui'
import { useSession } from '../hooks/useSession'
import { useStoreVersion } from '../hooks/useStore'
import { getCustomer } from '../lib/api/customers'
import { getReservation, listHistory, nextStatuses, transitionReservation } from '../lib/api/reservations'
import { menus, staffList } from '../lib/api/store'
import type { CancelReason, ReservationStatus } from '../lib/domain/types'

export const statusLabels: Record<ReservationStatus, string> = {
  requested: 'リクエスト',
  confirmed: '確定',
  checked_in: 'チェックイン',
  in_service: '施術中',
  completed: '完了',
  cancelled: 'キャンセル',
  no_show: '無断キャンセル',
}

const cancelReasons: { value: CancelReason; label: string }[] = [
  { value: 'customer_request', label: 'お客様都合' },
  { value: 'shop_request', label: '店舗都合' },
  { value: 'duplicate', label: '重複予約' },
  { value: 'other', label: 'その他' },
]

/** 進行方向の遷移に対する操作ラベル（§63 正常系） */
const forwardActionLabels: Partial<Record<ReservationStatus, string>> = {
  confirmed: '予約を確定',
  checked_in: 'チェックイン',
  in_service: '施術を開始',
  completed: '施術完了',
}

/** S-04 予約詳細（§63 状態遷移 + RESERVATION-008 変更履歴） */
export function ReservationDetail() {
  useStoreVersion()
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useSession()
  const [cancelling, setCancelling] = useState(false)
  const reservation = id ? getReservation(id) : undefined
  if (!reservation) {
    return <p className="text-stone">予約が見つかりません。</p>
  }
  const staff = staffList.find((s) => s.id === reservation.staffId)
  const customer = reservation.customerId ? getCustomer(reservation.customerId) : undefined
  const items = reservation.menuIds.map((mid) => menus.find((m) => m.id === mid)).filter((m) => m !== undefined)
  const total = items.reduce((s, m) => s + m.price, 0)
  const history = listHistory(reservation.id)
  const changedBy = user?.name ?? 'スタッフ'

  const statusTone = (
    {
      requested: 'amber',
      confirmed: 'sage',
      checked_in: 'gold',
      in_service: 'gold',
      completed: 'gold',
      cancelled: 'clay',
      no_show: 'clay',
    } as const
  )[reservation.status]

  const forward = nextStatuses(reservation.status).filter(
    (s) => s !== 'cancelled' && s !== 'no_show',
  )
  const canCancel = nextStatuses(reservation.status).includes('cancelled')
  const canNoShow = nextStatuses(reservation.status).includes('no_show')

  return (
    <div className="max-w-2xl">
      <PageHeader
        eyebrow="Reservations"
        title="予約詳細"
        action={<Tag tone={statusTone}>{statusLabels[reservation.status]}</Tag>}
      />
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

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-5">
          {customer ? (
            <Link to={`/customers/${customer.id}`}>
              <Button variant="ghost">カルテを開く</Button>
            </Link>
          ) : null}
          {forward.map((to) => (
            <Button key={to} onClick={() => transitionReservation(reservation.id, to, { changedBy })}>
              {forwardActionLabels[to] ?? statusLabels[to]}
            </Button>
          ))}
          {reservation.status === 'in_service' ? (
            <Link to="/checkout">
              <Button variant="ghost">会計へ</Button>
            </Link>
          ) : null}
          {canNoShow ? (
            <Button
              variant="danger"
              onClick={() => {
                if (window.confirm('無断キャンセルとして記録しますか？')) {
                  transitionReservation(reservation.id, 'no_show', { changedBy, reason: 'no_show' })
                }
              }}
            >
              無断キャンセル
            </Button>
          ) : null}
          {canCancel && !cancelling ? (
            <Button variant="danger" onClick={() => setCancelling(true)}>
              キャンセル
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => navigate(-1)}>
            戻る
          </Button>
        </div>

        {cancelling ? (
          <div className="mt-4 rounded-md bg-clay-tint px-4 py-3">
            <p className="mb-2 text-[12px] text-clay">キャンセル理由を選択してください（履歴に記録されます）</p>
            <div className="flex flex-wrap gap-2">
              {cancelReasons.map((r) => (
                <button
                  key={r.value}
                  onClick={() => {
                    transitionReservation(reservation.id, 'cancelled', { changedBy, reason: r.value })
                    setCancelling(false)
                  }}
                  className="rounded-md border border-clay/40 bg-paper px-3 py-1.5 text-[13px] text-clay hover:bg-clay hover:text-paper"
                >
                  {r.label}
                </button>
              ))}
              <button onClick={() => setCancelling(false)} className="px-3 py-1.5 text-[13px] text-stone hover:text-ink">
                やめる
              </button>
            </div>
          </div>
        ) : null}
      </Card>

      {history.length > 0 ? (
        <div className="mt-8">
          <SectionLabel>変更履歴</SectionLabel>
          <Card>
            <ul className="divide-y divide-line">
              {history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-[13px]">
                  <span className="tnum text-[12px] text-stone">
                    {format(new Date(h.changedAt), 'yyyy.MM.dd HH:mm')}
                  </span>
                  <span>
                    {statusLabels[h.before]} → {statusLabels[h.after]}
                  </span>
                  {h.reason ? (
                    <Tag tone="clay">{cancelReasons.find((r) => r.value === h.reason)?.label ?? h.reason}</Tag>
                  ) : null}
                  <span className="ml-auto text-[12px] text-stone">{h.changedBy}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ) : null}
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
