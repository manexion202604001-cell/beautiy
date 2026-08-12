import { useState } from 'react'
import { Button, Card, Field, Input, Textarea } from '../../components/ui'
import { BookingLayout } from './BookingLayout'

/** C-02 カウンセリングシート事前記入（サロン側で項目カスタマイズ可能な想定） */
export function Counseling() {
  const [done, setDone] = useState(false)
  const [name, setName] = useState('')
  const [allergy, setAllergy] = useState('')
  const [scalp, setScalp] = useState('')
  const [wish, setWish] = useState('')
  const [history, setHistory] = useState<string[]>([])

  const toggle = (v: string) =>
    setHistory((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]))

  if (done) {
    return (
      <BookingLayout>
        <Card className="p-8 text-center">
          <p className="font-display text-[22px] tracking-wide">ご記入ありがとうございます</p>
          <div className="mx-auto mt-4 h-px w-10 bg-gold" />
          <p className="mt-5 text-[13px] leading-relaxed text-stone">
            いただいた内容は担当スタイリストのカルテに反映されます。
            <br />
            当日お会いできることを楽しみにしております。
          </p>
        </Card>
      </BookingLayout>
    )
  }

  return (
    <BookingLayout>
      <h2 className="mb-1 font-display text-[20px] tracking-wide">カウンセリングシート</h2>
      <p className="mb-6 text-[12px] leading-relaxed text-stone">
        ご来店前にご記入いただくと、当日のカウンセリングがスムーズになります（約1分）。
      </p>
      <Card className="space-y-5 p-5">
        <Field label="お名前">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div>
          <p className="mb-2 text-[11px] uppercase tracking-[0.18em] text-stone">直近1年の施術歴（複数選択可）</p>
          <div className="flex flex-wrap gap-2">
            {['カラー', 'ブリーチ', 'パーマ', '縮毛矯正', '黒染め', 'セルフカラー'].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => toggle(v)}
                className={`rounded-md border px-3.5 py-2 text-[13px] transition-colors ${
                  history.includes(v) ? 'border-gold bg-gold-tint text-gold-deep' : 'border-line-strong hover:border-gold/60'
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        <Field label="アレルギー・お薬（ジアミン等）">
          <Textarea rows={2} value={allergy} onChange={(e) => setAllergy(e.target.value)} placeholder="例：カラー剤でかゆみが出たことがある" />
        </Field>
        <Field label="頭皮・肌のお悩み">
          <Textarea rows={2} value={scalp} onChange={(e) => setScalp(e.target.value)} />
        </Field>
        <Field label="なりたいイメージ・ご要望">
          <Textarea rows={3} value={wish} onChange={(e) => setWish(e.target.value)} placeholder="参考画像は当日お見せください" />
        </Field>
        <Button className="w-full" disabled={!name.trim()} onClick={() => setDone(true)}>
          送信する
        </Button>
      </Card>
    </BookingLayout>
  )
}
