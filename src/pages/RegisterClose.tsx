import { useState } from 'react'
import { Button, Card, Field, Input, PageHeader, SectionLabel, Tag, yen } from '../components/ui'
import { useSession } from '../hooks/useSession'
import { useStoreVersion } from '../hooks/useStore'
import { closeRegister, todayCashTheoretical } from '../lib/api/payments'
import { closings } from '../lib/api/store'

/** S-09 レジ締め（現金実査 → 差異表示 → 確定） */
export function RegisterClose() {
  useStoreVersion()
  const { user } = useSession()
  const [counted, setCounted] = useState('')
  const theoretical = todayCashTheoretical()
  const countedNum = counted === '' ? null : Number(counted)
  const diff = countedNum === null ? null : countedNum - theoretical
  const canClose = user?.role === 'owner' || user?.role === 'manager'

  return (
    <div className="max-w-2xl">
      <PageHeader eyebrow="Cashier" title="レジ締め" />

      {!canClose ? (
        <div className="mb-5 rounded-lg border border-amber/30 bg-amber-tint px-5 py-3 text-[13px] text-amber">
          レジ締めの確定はオーナー・店長権限のみ可能です（現在: 閲覧のみ）。
        </div>
      ) : null}

      <Card className="space-y-5 p-6">
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-md bg-paper-warm p-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-stone">現金理論値（本日確定分）</p>
            <p className="tnum mt-2 font-display text-[26px]">{yen(theoretical)}</p>
          </div>
          <div className="rounded-md bg-paper-warm p-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-stone">差異</p>
            <p
              className={`tnum mt-2 font-display text-[26px] ${
                diff === null ? 'text-stone' : diff === 0 ? 'text-sage' : 'text-clay'
              }`}
            >
              {diff === null ? '—' : yen(diff)}
            </p>
          </div>
        </div>

        <Field label="現金実査額（レジ内の実際の現金）">
          <Input
            type="number"
            inputMode="numeric"
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
            placeholder="0"
          />
        </Field>

        {diff !== null && diff !== 0 ? (
          <p className="rounded-md bg-clay-tint px-4 py-3 text-[13px] text-clay">
            理論値と {yen(Math.abs(diff))} の差異があります。原因を確認のうえ確定してください（差異は記録されます）。
          </p>
        ) : null}

        <Button
          disabled={countedNum === null || !canClose}
          onClick={() => {
            closeRegister(countedNum ?? 0, user?.staffId ?? '')
            setCounted('')
          }}
        >
          レジ締めを確定する
        </Button>
        <p className="text-[11px] text-stone">
          締め後の会計修正は権限者のみ・監査ログ記録のうえで打消し伝票により行います。
        </p>
      </Card>

      <div className="mt-8">
        <SectionLabel>締め履歴</SectionLabel>
        <Card>
          <ul className="divide-y divide-line">
            {closings.map((c) => {
              const d = (c.countedCash ?? 0) - c.theoreticalCash
              return (
                <li key={c.id} className="flex items-center justify-between px-5 py-3.5 text-[13px]">
                  <span>{c.date}</span>
                  <span className="tnum text-stone">理論 {yen(c.theoreticalCash)} / 実査 {yen(c.countedCash ?? 0)}</span>
                  {d === 0 ? <Tag tone="sage">差異なし</Tag> : <Tag tone="clay">{yen(d)}</Tag>}
                </li>
              )
            })}
          </ul>
        </Card>
      </div>
    </div>
  )
}
