import { format } from 'date-fns'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Card, Field, Input, PageHeader, Textarea } from '../components/ui'
import { useSession } from '../hooks/useSession'
import { addKarte, getCustomer } from '../lib/api/customers'
import { menus } from '../lib/api/store'
import type { RecipeLine } from '../lib/domain/types'

const emptyLine: RecipeLine = { brand: '', product: '', ratio: '', minutes: null }

/** S-07 カルテ入力（構造化レシピ） */
export function KarteNew() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useSession()
  const customer = id ? getCustomer(id) : undefined
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [menuIds, setMenuIds] = useState<string[]>([])
  const [recipe, setRecipe] = useState<RecipeLine[]>([{ ...emptyLine }])
  const [recipeNote, setRecipeNote] = useState('')
  const [memo, setMemo] = useState('')

  if (!customer) {
    return <p className="text-stone">お客様が見つかりません。</p>
  }

  const selected = menus.filter((m) => menuIds.includes(m.id))
  const amount = selected.reduce((s, m) => s + m.price, 0)
  const duration = selected.reduce((s, m) => s + m.durationMin, 0)

  const updateLine = (i: number, patch: Partial<RecipeLine>) =>
    setRecipe((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))

  const save = () => {
    addKarte({
      customerId: customer.id,
      staffId: user?.staffId ?? 'st-1',
      date,
      menuNames: selected.map((m) => m.name),
      durationMin: duration,
      amount,
      recipe: recipe.filter((l) => l.brand || l.product),
      recipeNote,
      memo,
      photoCount: 0,
    })
    navigate(`/customers/${customer.id}`)
  }

  return (
    <div className="max-w-2xl">
      <PageHeader eyebrow="Karte" title={`カルテ入力 — ${customer.name} 様`} />

      {customer.warnings.length > 0 ? (
        <div className="mb-5 rounded-lg border border-clay/40 bg-clay-tint px-5 py-3 text-[13px] text-clay">
          {customer.warnings.join(' ／ ')}
        </div>
      ) : null}

      <Card className="space-y-5 p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="施術日">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>

        <div>
          <p className="mb-2 text-[11px] uppercase tracking-[0.18em] text-stone">施術メニュー</p>
          <div className="flex flex-wrap gap-2">
            {menus.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() =>
                  setMenuIds((prev) => (prev.includes(m.id) ? prev.filter((x) => x !== m.id) : [...prev, m.id]))
                }
                className={`rounded-md border px-3 py-2 text-[13px] transition-colors ${
                  menuIds.includes(m.id)
                    ? 'border-gold bg-gold-tint text-gold-deep'
                    : 'border-line-strong text-ink-soft hover:border-gold'
                }`}
              >
                {m.name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 text-[11px] uppercase tracking-[0.18em] text-stone">レシピ（薬剤調合）</p>
          <div className="space-y-2">
            {recipe.map((line, i) => (
              <div key={i} className="grid grid-cols-[1fr_1.4fr_0.8fr_0.7fr] gap-2">
                <Input placeholder="メーカー" value={line.brand} onChange={(e) => updateLine(i, { brand: e.target.value })} />
                <Input placeholder="薬剤・品番" value={line.product} onChange={(e) => updateLine(i, { product: e.target.value })} />
                <Input placeholder="比率 2:1" value={line.ratio} onChange={(e) => updateLine(i, { ratio: e.target.value })} />
                <Input
                  placeholder="放置分"
                  type="number"
                  value={line.minutes ?? ''}
                  onChange={(e) => updateLine(i, { minutes: e.target.value ? Number(e.target.value) : null })}
                />
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setRecipe((prev) => [...prev, { ...emptyLine }])}
            className="mt-2 text-[12px] tracking-wide text-gold-deep hover:underline"
          >
            ＋ 行を追加
          </button>
        </div>

        <Field label="レシピ補足（自由記述）">
          <Textarea rows={2} value={recipeNote} onChange={(e) => setRecipeNote(e.target.value)} />
        </Field>

        <Field label="接客メモ">
          <Textarea rows={3} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="会話・好み・次回提案など" />
        </Field>

        <div className="flex items-center gap-3 rounded-md bg-paper-warm px-4 py-3 text-[13px] text-ink-soft">
          <span>写真添付（施術前後・最大20枚）</span>
          <span className="rounded-sm border border-dashed border-line-strong px-3 py-1.5 text-[12px] text-stone">
            本番では Supabase Storage（非公開バケット + 署名付きURL）へアップロード
          </span>
        </div>

        <div className="flex gap-3">
          <Button onClick={save} disabled={menuIds.length === 0}>
            カルテを保存
          </Button>
          <Button variant="ghost" onClick={() => navigate(-1)}>
            戻る
          </Button>
        </div>
      </Card>
    </div>
  )
}
