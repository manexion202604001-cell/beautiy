import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, EmptyState, Input, PageHeader, Select, Tag } from '../components/ui'
import { useStoreVersion } from '../hooks/useStore'
import { listAllTags, searchCustomers } from '../lib/api/customers'
import { staffList } from '../lib/api/store'

/** S-05 顧客一覧 / 検索 */
export function Customers() {
  useStoreVersion()
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState('')
  const [staffId, setStaffId] = useState('')
  const customers = searchCustomers({ query, tag: tag || undefined, staffId: staffId || undefined })
  const tags = listAllTags()

  return (
    <div>
      <PageHeader eyebrow="Customers" title="顧客台帳" />

      <div className="mb-5 grid gap-3 sm:grid-cols-[1fr_180px_180px]">
        <Input
          placeholder="氏名・カナ・電話番号で検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select value={tag} onChange={setTag}>
          <option value="">すべてのタグ</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Select value={staffId} onChange={setStaffId}>
          <option value="">担当（個人所有）</option>
          {staffList.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>

      {customers.length === 0 ? (
        <EmptyState>該当するお客様が見つかりません</EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {customers.map((c) => (
              <li key={c.id}>
                <Link to={`/customers/${c.id}`} className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-paper-warm">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gold-tint font-display text-[16px] text-gold-deep">
                    {c.name.charAt(0)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-[14px]">
                      <span className="truncate">{c.name}</span>
                      <span className="text-[11px] text-stone">{c.nameKana}</span>
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[12px] text-stone">
                      <span className="tnum">{c.phone}</span>
                      <span>最終来店 {c.lastVisit ?? '—'}</span>
                      <span>来店 {c.visitCount} 回</span>
                    </p>
                  </div>
                  <div className="hidden items-center gap-1.5 sm:flex">
                    {c.warnings.length > 0 ? <Tag tone="clay">警告</Tag> : null}
                    {c.ownerType === 'staff' ? <Tag tone="amber">個人顧客</Tag> : null}
                    {c.tags.map((t) => (
                      <Tag key={t} tone={t === 'VIP' ? 'gold' : 'neutral'}>
                        {t}
                      </Tag>
                    ))}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
