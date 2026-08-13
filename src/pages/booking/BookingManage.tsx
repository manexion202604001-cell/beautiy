import { format } from 'date-fns'
import { ja } from 'date-fns/locale'
import { Link } from 'react-router-dom'
import { Button, Card, Tag } from '../../components/ui'
import { useStoreVersion } from '../../hooks/useStore'
import { canTransition, listReservations, transitionReservation } from '../../lib/api/reservations'
import { menus, staffList } from '../../lib/api/store'
import { BookingLayout } from './BookingLayout'

/** C-03 予約確認 / 変更 / キャンセル（マイページ簡易版・デモではWeb予約分を表示） */
export function BookingManage() {
  useStoreVersion()
  const mine = listReservations()
    .filter((r) => r.source === 'web' && new Date(r.start) > new Date())
    .sort((a, b) => a.start.localeCompare(b.start))

  return (
    <BookingLayout>
      <h2 className="mb-1 font-display text-[20px] tracking-wide">ご予約の確認</h2>
      <p className="mb-6 text-[12px] text-stone">今後のWeb予約が表示されます。</p>

      {mine.length === 0 ? (
        <Card className="p-8 text-center text-[13px] text-stone">
          今後のご予約はありません。
          <Link to="/booking" className="mt-3 block text-gold-deep underline">
            新しく予約する
          </Link>
        </Card>
      ) : (
        <div className="space-y-4">
          {mine.map((r) => {
            const cancelled = r.status === 'cancelled'
            return (
              <Card key={r.id} className={`p-5 ${cancelled ? 'opacity-55' : ''}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[14px]">
                      {format(new Date(r.start), 'yyyy年M月d日（E） HH:mm', { locale: ja })}〜
                    </p>
                    <p className="mt-1 text-[12px] text-stone">
                      {r.menuIds.map((id) => menus.find((m) => m.id === id)?.name).join('・')} ／{' '}
                      {staffList.find((s) => s.id === r.staffId)?.name}
                    </p>
                  </div>
                  {cancelled ? <Tag tone="clay">キャンセル済</Tag> : <Tag tone="sage">確定</Tag>}
                </div>
                {!cancelled && canTransition(r.status, 'cancelled') ? (
                  <div className="mt-4 flex gap-3 border-t border-line pt-4">
                    <Link to="/booking" className="flex-1">
                      <Button variant="ghost" className="w-full">
                        日時を変更
                      </Button>
                    </Link>
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (window.confirm('この予約をキャンセルしますか？')) {
                          transitionReservation(r.id, 'cancelled', {
                            changedBy: 'お客様（Web）',
                            reason: 'customer_request',
                          })
                        }
                      }}
                    >
                      キャンセル
                    </Button>
                  </div>
                ) : null}
              </Card>
            )
          })}
          <p className="text-[11px] leading-relaxed text-stone">
            前日以降のキャンセルはお電話にてご連絡ください。無断キャンセルは今後のご予約をお受けできない場合がございます。
          </p>
        </div>
      )}
    </BookingLayout>
  )
}
