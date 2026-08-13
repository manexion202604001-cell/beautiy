import { format } from 'date-fns'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, yen } from '../components/ui'
import { getPayment, paymentTotal } from '../lib/api/payments'
import { salon } from '../lib/api/store'

/**
 * F-04-09 領収書（インボイス制度対応: 適格請求書発行事業者番号を印字）
 * 印刷専用レイアウト。ブラウザの印刷機能でA5/レシート紙に出力する。
 * 価格は税込（内税10%）。
 */
export function Receipt() {
  const { id } = useParams()
  const navigate = useNavigate()
  const payment = id ? getPayment(id) : undefined

  if (!payment || payment.status === 'draft') {
    return (
      <div className="p-10 text-center text-stone">
        確定済みの伝票が見つかりません。
        <button onClick={() => navigate(-1)} className="mt-4 block w-full text-gold-deep underline">
          戻る
        </button>
      </div>
    )
  }

  const total = paymentTotal(payment)
  const tax = Math.floor((total * 10) / 110)
  const issuedAt = payment.fixedAt ? new Date(payment.fixedAt) : new Date()

  return (
    <div className="min-h-dvh bg-porcelain print:bg-paper">
      <div className="mx-auto max-w-md px-6 py-8">
        <div className="print:hidden mb-6 flex gap-3">
          <Button onClick={() => window.print()}>印刷する</Button>
          <Button variant="ghost" onClick={() => navigate(-1)}>
            戻る
          </Button>
        </div>

        <div className="rounded-lg border border-line bg-paper p-8 print:rounded-none print:border-0 print:p-0">
          <header className="text-center">
            <p className="font-display text-[22px] tracking-[0.28em] text-night">BEAUTIY</p>
            <p className="mt-1 text-[11px] text-stone">{salon.name}</p>
            <h1 className="mt-6 font-display text-[20px] tracking-[0.2em]">領 収 書</h1>
            <div className="mx-auto mt-3 h-px w-10 bg-gold" />
          </header>

          <div className="mt-6 space-y-1 text-[13px]">
            <p className="flex justify-between">
              <span className="text-stone">発行日</span>
              <span className="tnum">{format(issuedAt, 'yyyy年M月d日')}</span>
            </p>
            <p className="flex justify-between">
              <span className="text-stone">宛名</span>
              <span>{payment.customerName} 様</span>
            </p>
            <p className="flex justify-between">
              <span className="text-stone">伝票番号</span>
              <span className="tnum">{payment.id}</span>
            </p>
          </div>

          <table className="mt-6 w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[10px] uppercase tracking-[0.16em] text-stone">
                <th className="pb-2 font-normal">品目</th>
                <th className="pb-2 text-right font-normal">数量</th>
                <th className="pb-2 text-right font-normal">金額</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {payment.items.map((item, i) => (
                <tr key={i}>
                  <td className="py-2">
                    {item.name}
                    <span className="ml-1.5 text-[10px] text-stone">{item.kind === 'product' ? '（店販）' : ''}</span>
                  </td>
                  <td className="tnum py-2 text-right">{item.quantity}</td>
                  <td className="tnum py-2 text-right">{yen(item.price * item.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4 space-y-1 border-t-2 border-night pt-3 text-[13px]">
            <p className="flex justify-between text-[16px]">
              <span>合計（税込）</span>
              <span className="tnum font-display">{yen(total)}</span>
            </p>
            <p className="flex justify-between text-[11px] text-stone">
              <span>（内 消費税10%）</span>
              <span className="tnum">{yen(tax)}</span>
            </p>
          </div>

          {payment.tenders.length > 0 ? (
            <div className="mt-4 space-y-1 text-[12px] text-ink-soft">
              {payment.tenders.map((t, i) => (
                <p key={i} className="flex justify-between">
                  <span className="text-stone">{t.label}</span>
                  <span className="tnum">{yen(t.amount)}</span>
                </p>
              ))}
            </div>
          ) : null}

          <footer className="mt-8 border-t border-line pt-4 text-center text-[11px] leading-relaxed text-stone">
            <p>{salon.name}</p>
            <p>
              適格請求書発行事業者番号：<span className="tnum">{salon.invoiceNumber}</span>
            </p>
            <p className="mt-2">上記正に領収いたしました</p>
          </footer>
        </div>
      </div>
    </div>
  )
}
