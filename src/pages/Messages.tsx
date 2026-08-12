import { format } from 'date-fns'
import { useState } from 'react'
import { Button, Card, Input, PageHeader, Tag } from '../components/ui'
import { useStoreVersion } from '../hooks/useStore'
import { getCustomer } from '../lib/api/customers'
import { listMessages, listThreads, markRead, sendMessage } from '../lib/api/messages'

/** S-10 メッセージ（スレッド + 自動メッセージ表示） */
export function Messages() {
  useStoreVersion()
  const threads = listThreads()
  const [activeId, setActiveId] = useState(threads[0]?.id ?? '')
  const [draft, setDraft] = useState('')
  const active = threads.find((t) => t.id === activeId)
  const msgs = active ? listMessages(active.id) : []
  const customer = active ? getCustomer(active.customerId) : undefined

  return (
    <div>
      <PageHeader eyebrow="Communication" title="メッセージ" />
      <div className="grid gap-5 md:grid-cols-[280px_1fr]">
        <Card>
          <ul className="divide-y divide-line">
            {threads.map((t) => {
              const c = getCustomer(t.customerId)
              return (
                <li key={t.id}>
                  <button
                    onClick={() => {
                      setActiveId(t.id)
                      markRead(t.id)
                    }}
                    className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors ${
                      t.id === activeId ? 'bg-gold-tint/60' : 'hover:bg-paper-warm'
                    }`}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-porcelain font-display text-[14px] text-gold-deep">
                      {c?.name.charAt(0) ?? '?'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px]">{c?.name} 様</p>
                      <p className="text-[11px] text-stone">
                        {format(new Date(t.lastMessageAt), 'M/d HH:mm')} ・ {t.channel.toUpperCase()}
                      </p>
                    </div>
                    {t.unread > 0 ? <Tag tone="clay">{t.unread}</Tag> : null}
                  </button>
                </li>
              )
            })}
          </ul>
        </Card>

        <Card className="flex min-h-[420px] flex-col">
          <div className="border-b border-line px-5 py-3.5">
            <p className="text-[14px]">{customer?.name} 様</p>
            <p className="text-[11px] text-stone">
              {active?.channel === 'line' ? 'LINE公式アカウント連携' : 'アプリ内メッセージ'}
            </p>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
            {msgs.map((m) => (
              <div key={m.id} className={`flex ${m.from === 'customer' ? 'justify-start' : 'justify-end'}`}>
                <div
                  className={`max-w-[75%] rounded-lg px-4 py-2.5 text-[13px] leading-relaxed ${
                    m.from === 'customer'
                      ? 'bg-porcelain text-ink'
                      : m.from === 'auto'
                        ? 'border border-gold/30 bg-gold-tint/50 text-ink-soft'
                        : 'bg-night text-paper-warm'
                  }`}
                >
                  {m.from === 'auto' ? (
                    <p className="mb-1 text-[10px] uppercase tracking-[0.16em] text-gold-deep">自動送信</p>
                  ) : null}
                  {m.body}
                  <p className={`mt-1 text-[10px] ${m.from === 'salon' ? 'text-paper-warm/50' : 'text-stone'}`}>
                    {format(new Date(m.at), 'HH:mm')}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-2 border-t border-line px-5 py-3.5">
            <Input
              placeholder="メッセージを入力…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && draft.trim() && active) {
                  sendMessage(active.id, draft.trim())
                  setDraft('')
                }
              }}
            />
            <Button
              disabled={!draft.trim() || !active}
              onClick={() => {
                if (active) {
                  sendMessage(active.id, draft.trim())
                  setDraft('')
                }
              }}
            >
              送信
            </Button>
          </div>
        </Card>
      </div>
      <p className="mt-3 text-[11px] text-stone">
        LINE送受信・リマインド等の自動メッセージは n8n ワークフロー経由で処理されます（本システムは履歴の保存・表示を担当）。
      </p>
    </div>
  )
}
