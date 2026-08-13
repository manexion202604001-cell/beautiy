import { differenceInYears, format } from 'date-fns'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button, Card, EmptyState, PageHeader, SectionLabel, Tag, Textarea, yen } from '../components/ui'
import { useSession } from '../hooks/useSession'
import { useStoreVersion } from '../hooks/useStore'
import { addMemo, getCustomer, listKarteMemos, listKartes } from '../lib/api/customers'
import { staffList } from '../lib/api/store'

/** S-06 顧客カルテ詳細 */
export function CustomerDetail() {
  useStoreVersion()
  const { id } = useParams()
  const { user } = useSession()
  const [memoDraft, setMemoDraft] = useState('')
  const customer = id ? getCustomer(id) : undefined
  if (!customer) {
    return <p className="text-stone">お客様が見つかりません。</p>
  }
  const kartes = listKartes(customer.id)
  const memos = listKarteMemos(customer.id)
  const staffName = (sid: string) => staffList.find((s) => s.id === sid)?.name ?? '—'
  const age = customer.birthday ? differenceInYears(new Date(), new Date(customer.birthday)) : null

  return (
    <div>
      <PageHeader
        eyebrow="Customer Karte"
        title={`${customer.name} 様`}
        action={
          <div className="flex gap-2">
            <Link to={`/customers/${customer.id}/edit`}>
              <Button variant="ghost">編集</Button>
            </Link>
            <Link to={`/customers/${customer.id}/karte/new`}>
              <Button>カルテを書く</Button>
            </Link>
          </div>
        }
      />

      {/* F-01-11 警告の最上部強調表示 */}
      {customer.warnings.length > 0 ? (
        <div className="mb-6 rounded-lg border border-clay/40 bg-clay-tint px-5 py-4">
          <p className="text-[11px] uppercase tracking-[0.2em] text-clay">Warning — 施術前に必ず確認</p>
          <ul className="mt-2 space-y-1 text-[14px] text-clay">
            {customer.warnings.map((w) => (
              <li key={w}>・{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[1fr_1.6fr]">
        <div className="space-y-6">
          <Card className="p-5">
            <SectionLabel>基本情報</SectionLabel>
            <dl className="space-y-3 text-[13px]">
              <Row label="フリガナ">{customer.nameKana}</Row>
              <Row label="電話">
                <span className="tnum">{customer.phone}</span>
              </Row>
              <Row label="メール">{customer.email}</Row>
              <Row label="生年月日">
                {customer.birthday ? `${customer.birthday}（${age}歳）` : '—'}
              </Row>
              <Row label="来店経路">{customer.channel}</Row>
              <Row label="LINE連携">{customer.lineLinked ? <Tag tone="sage">連携済</Tag> : <Tag>未連携</Tag>}</Row>
              <Row label="所有区分">
                {customer.ownerType === 'salon' ? (
                  'サロン顧客'
                ) : (
                  <span>個人顧客（{staffName(customer.ownerStaffId ?? '')}）</span>
                )}
              </Row>
              <Row label="タグ">
                <span className="flex flex-wrap gap-1.5">
                  {customer.tags.map((t) => (
                    <Tag key={t} tone={t === 'VIP' ? 'gold' : 'neutral'}>
                      {t}
                    </Tag>
                  ))}
                </span>
              </Row>
            </dl>
          </Card>

          <Card className="p-5">
            <SectionLabel>ご利用サマリー</SectionLabel>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="tnum font-display text-[22px]">{customer.visitCount}</p>
                <p className="text-[11px] text-stone">来店回数</p>
              </div>
              <div>
                <p className="tnum font-display text-[22px]">{customer.visitCycleDays ?? '—'}</p>
                <p className="text-[11px] text-stone">来店周期(日)</p>
              </div>
              <div>
                <p className="tnum font-display text-[18px] leading-[30px]">{yen(customer.totalSpent)}</p>
                <p className="text-[11px] text-stone">累計利用額</p>
              </div>
            </div>
            {customer.note ? (
              <p className="mt-4 border-t border-line pt-3 text-[13px] leading-relaxed text-ink-soft">{customer.note}</p>
            ) : null}
          </Card>

          <Card className="p-5">
            <SectionLabel>接客メモ（担当外も追記可）</SectionLabel>
            <ul className="space-y-3">
              {memos.map((m) => (
                <li key={m.id} className="rounded-md bg-paper-warm px-3.5 py-3 text-[13px] leading-relaxed">
                  {m.body}
                  <p className="mt-1.5 text-[11px] text-stone">
                    {staffName(m.staffId)} ・ {m.date}
                  </p>
                </li>
              ))}
              {memos.length === 0 ? <li className="text-[13px] text-stone">メモはまだありません</li> : null}
            </ul>
            <div className="mt-4 space-y-2">
              <Textarea
                rows={2}
                placeholder="会話内容・好み・NG事項など"
                value={memoDraft}
                onChange={(e) => setMemoDraft(e.target.value)}
              />
              <Button
                variant="ghost"
                disabled={!memoDraft.trim()}
                onClick={() => {
                  addMemo(customer.id, user?.staffId ?? 'st-1', memoDraft.trim())
                  setMemoDraft('')
                }}
              >
                メモを追加
              </Button>
            </div>
          </Card>
        </div>

        <div>
          <SectionLabel>施術履歴タイムライン</SectionLabel>
          {kartes.length === 0 ? (
            <EmptyState>施術履歴はまだありません</EmptyState>
          ) : (
            <ol className="relative space-y-5 border-l border-line-strong pl-6">
              {kartes.map((k) => (
                <li key={k.id} className="relative">
                  <span className="absolute -left-[29px] top-2 h-[7px] w-[7px] rounded-full bg-gold" />
                  <Card className="p-5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-[14px] tracking-wide">
                        {format(new Date(k.date), 'yyyy.MM.dd')}
                        <span className="ml-3 text-[12px] text-stone">担当 {staffName(k.staffId)}</span>
                      </p>
                      <p className="tnum text-[14px] text-ink-soft">{yen(k.amount)}</p>
                    </div>
                    <p className="mt-1.5 text-[13px] text-gold-deep">{k.menuNames.join(' ・ ')}</p>

                    {k.recipe.length > 0 ? (
                      <div className="mt-3 overflow-x-auto rounded-md bg-paper-warm p-3">
                        <table className="w-full text-[12px]">
                          <thead>
                            <tr className="text-left text-[10px] uppercase tracking-[0.14em] text-stone">
                              <th className="pb-1.5 pr-4 font-normal">メーカー</th>
                              <th className="pb-1.5 pr-4 font-normal">薬剤・品番</th>
                              <th className="pb-1.5 pr-4 font-normal">比率</th>
                              <th className="pb-1.5 font-normal">放置</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-line">
                            {k.recipe.map((r, i) => (
                              <tr key={i}>
                                <td className="py-1.5 pr-4">{r.brand}</td>
                                <td className="py-1.5 pr-4">{r.product}</td>
                                <td className="tnum py-1.5 pr-4">{r.ratio}</td>
                                <td className="tnum py-1.5">{r.minutes ? `${r.minutes}分` : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {k.recipeNote ? (
                          <p className="mt-2 border-t border-line pt-2 text-[12px] leading-relaxed text-ink-soft">
                            {k.recipeNote}
                          </p>
                        ) : null}
                      </div>
                    ) : null}

                    {k.memo ? (
                      <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">{k.memo}</p>
                    ) : null}

                    {k.photoCount > 0 ? (
                      <div className="mt-3 flex gap-2">
                        {Array.from({ length: Math.min(k.photoCount, 4) }, (_, i) => (
                          <div
                            key={i}
                            className="flex h-14 w-14 items-center justify-center rounded-md border border-line bg-porcelain text-[10px] text-stone"
                          >
                            Photo
                          </div>
                        ))}
                        {k.photoCount > 4 ? (
                          <div className="flex h-14 w-14 items-center justify-center rounded-md border border-dashed border-line-strong text-[11px] text-stone">
                            +{k.photoCount - 4}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </Card>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-[11px] uppercase tracking-[0.16em] text-stone">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  )
}
