import { format } from 'date-fns'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, EmptyState, Field, Input, PageHeader, SectionLabel, Select, Tag, yen } from '../components/ui'
import { useSession } from '../hooks/useSession'
import { useStoreVersion } from '../hooks/useStore'
import { searchCustomers } from '../lib/api/customers'
import { fixPayment, listPayments, paymentTotal, reversePayment, saveDraft } from '../lib/api/payments'
import { menus, staffList } from '../lib/api/store'
import type { PaymentItem, PaymentMethodKind, PaymentTender } from '../lib/domain/types'

const tenderKinds: { kind: PaymentMethodKind; label: string }[] = [
  { kind: 'cash', label: '現金' },
  { kind: 'credit', label: 'クレジット' },
  { kind: 'emoney', label: '電子マネー' },
  { kind: 'qr', label: 'QR決済' },
  { kind: 'custom', label: 'その他（回数券等）' },
]

/** S-08 会計（下書き → 確定 / 複合支払 / 打消し伝票） */
export function Checkout() {
  useStoreVersion()
  const { user } = useSession()
  const [open, setOpen] = useState(false)
  const payments = listPayments()

  return (
    <div>
      <PageHeader
        eyebrow="POS"
        title="会計"
        action={<Button onClick={() => setOpen((v) => !v)}>{open ? '閉じる' : '新規会計'}</Button>}
      />

      {open ? <NewPaymentForm onDone={() => setOpen(false)} /> : null}

      <SectionLabel>伝票一覧</SectionLabel>
      {payments.length === 0 ? (
        <EmptyState>伝票はまだありません</EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {payments.map((p) => {
              const total = paymentTotal(p)
              return (
                <li key={p.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px]">
                        {p.customerName}
                        {p.reversalOf ? <span className="ml-2 text-[11px] text-clay">（打消し伝票）</span> : null}
                      </p>
                      <p className="mt-0.5 text-[12px] text-stone">
                        {format(new Date(p.createdAt), 'yyyy.MM.dd HH:mm')} ・{' '}
                        {p.items.map((i) => i.name).join('、')}
                      </p>
                    </div>
                    <p className={`tnum text-[15px] ${total < 0 ? 'text-clay' : 'text-ink'}`}>{yen(total)}</p>
                    {p.status === 'draft' ? <Tag tone="amber">下書き</Tag> : null}
                    {p.status === 'fixed' ? <Tag tone="sage">確定</Tag> : null}
                    {p.status === 'voided' ? <Tag tone="clay">取消済</Tag> : null}
                    {p.status === 'draft' ? (
                      <Button variant="ghost" onClick={() => fixPayment(p.id)}>
                        確定
                      </Button>
                    ) : null}
                    {p.status === 'fixed' && !p.reversalOf ? (
                      <Link to={`/receipts/${p.id}`}>
                        <Button variant="ghost">領収書</Button>
                      </Link>
                    ) : null}
                    {p.status === 'fixed' && !p.reversalOf ? (
                      <Button
                        variant="danger"
                        onClick={() => {
                          const reason = window.prompt('取消理由を入力してください（監査ログに記録されます）')
                          if (reason) reversePayment(p.id, reason)
                        }}
                      >
                        取消
                      </Button>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        </Card>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-stone">
        確定済み伝票は変更できません。修正は打消し伝票（マイナス伝票）＋新伝票で行い、全操作が監査ログに記録されます。
        領収書PDFは適格請求書発行事業者番号を印字して発行されます（本番実装）。
      </p>
      <span className="hidden">{user?.name}</span>
    </div>
  )
}

function NewPaymentForm({ onDone }: { onDone: () => void }) {
  const customers = searchCustomers({})
  const [customerId, setCustomerId] = useState('')
  const [items, setItems] = useState<PaymentItem[]>([])
  const [tenders, setTenders] = useState<PaymentTender[]>([])
  const [tenderKind, setTenderKind] = useState<PaymentMethodKind>('cash')
  const [tenderAmount, setTenderAmount] = useState('')

  const total = items.reduce((s, i) => s + i.price * i.quantity, 0)
  const tendered = tenders.reduce((s, t) => s + t.amount, 0)
  const remaining = total - tendered

  const addItem = (menuId: string) => {
    const m = menus.find((x) => x.id === menuId)
    if (!m) return
    setItems((prev) => [
      ...prev,
      { name: m.name, kind: 'service', price: m.price, quantity: 1, staffId: staffList[0].id, nominated: true },
    ])
  }

  const save = (asDraft: boolean) => {
    const customer = customers.find((c) => c.id === customerId)
    const p = saveDraft({
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? 'ウォークイン',
      items,
      tenders,
    })
    if (!asDraft) fixPayment(p.id)
    onDone()
  }

  return (
    <Card className="mb-8 space-y-5 p-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="お客様">
          <Select value={customerId} onChange={setCustomerId}>
            <option value="">ウォークイン</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="メニュー追加">
          <Select value="" onChange={addItem}>
            <option value="">選択して追加…</option>
            {menus.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} — {yen(m.price)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {items.length > 0 ? (
        <ul className="divide-y divide-line rounded-md border border-line">
          {items.map((i, idx) => (
            <li key={idx} className="flex items-center justify-between px-4 py-2.5 text-[13px]">
              <span>{i.name}</span>
              <span className="flex items-center gap-4">
                <span className="tnum">{yen(i.price)}</span>
                <button
                  onClick={() => setItems((prev) => prev.filter((_, j) => j !== idx))}
                  className="text-[11px] text-stone hover:text-clay"
                >
                  削除
                </button>
              </span>
            </li>
          ))}
          <li className="flex items-center justify-between bg-paper-warm px-4 py-2.5 text-[14px]">
            <span>合計（税込）</span>
            <span className="tnum">{yen(total)}</span>
          </li>
        </ul>
      ) : null}

      <div>
        <p className="mb-2 text-[11px] uppercase tracking-[0.18em] text-stone">支払（複合可）</p>
        <div className="flex flex-wrap items-end gap-2">
          <Select value={tenderKind} onChange={(v) => setTenderKind(v as PaymentMethodKind)} className="w-44">
            {tenderKinds.map((t) => (
              <option key={t.kind} value={t.kind}>
                {t.label}
              </option>
            ))}
          </Select>
          <Input
            type="number"
            placeholder={remaining > 0 ? `残り ${remaining}` : '金額'}
            value={tenderAmount}
            onChange={(e) => setTenderAmount(e.target.value)}
            className="w-36"
          />
          <Button
            variant="ghost"
            disabled={!tenderAmount || Number(tenderAmount) <= 0}
            onClick={() => {
              const label = tenderKinds.find((t) => t.kind === tenderKind)?.label ?? tenderKind
              setTenders((prev) => [...prev, { kind: tenderKind, label, amount: Number(tenderAmount) }])
              setTenderAmount('')
            }}
          >
            追加
          </Button>
        </div>
        {tenders.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-2 text-[12px]">
            {tenders.map((t, i) => (
              <li key={i} className="rounded-sm bg-gold-tint px-2.5 py-1 text-gold-deep">
                {t.label} <span className="tnum">{yen(t.amount)}</span>
              </li>
            ))}
            <li className={`px-2.5 py-1 ${remaining === 0 ? 'text-sage' : 'text-clay'}`}>
              {remaining === 0 ? '過不足なし' : `残り ${yen(remaining)}`}
            </li>
          </ul>
        ) : null}
      </div>

      <div className="flex gap-3">
        <Button disabled={items.length === 0 || remaining !== 0} onClick={() => save(false)}>
          会計を確定
        </Button>
        <Button variant="ghost" disabled={items.length === 0} onClick={() => save(true)}>
          下書き保存（施術中）
        </Button>
      </div>
    </Card>
  )
}
