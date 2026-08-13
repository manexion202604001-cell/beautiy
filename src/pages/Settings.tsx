import { format } from 'date-fns'
import { Button, Card, PageHeader, SectionLabel, Tag, yen } from '../components/ui'
import { useStoreVersion } from '../hooks/useStore'
import { hasSavedData, resetDb } from '../lib/api/persist'
import { auditLogs, menus, salon, staffList } from '../lib/api/store'
import { isSupabaseConfigured } from '../lib/supabase/client'
import { roleLabel } from './Login'

/** S-12 店舗設定（営業・メニュー・スタッフ権限・連携・監査ログ） */
export function Settings() {
  useStoreVersion()
  return (
    <div>
      <PageHeader eyebrow="Settings" title="店舗設定" />

      <div className="grid gap-8 lg:grid-cols-2">
        <section>
          <SectionLabel>店舗情報</SectionLabel>
          <Card className="p-5">
            <dl className="space-y-3 text-[13px]">
              <Row label="店舗名">{salon.name}</Row>
              <Row label="営業時間">
                {salon.openTime} – {salon.closeTime}（月曜定休）
              </Row>
              <Row label="適格請求書番号">
                <span className="tnum">{salon.invoiceNumber}</span>
              </Row>
              <Row label="Web予約URL">
                <a href="/booking" className="text-gold-deep hover:underline">
                  /booking（24時間受付）
                </a>
              </Row>
            </dl>
          </Card>

          <div className="mt-8">
            <SectionLabel>スタッフと権限</SectionLabel>
            <Card>
              <ul className="divide-y divide-line">
                {staffList.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-5 py-3.5">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                    <span className="flex-1 text-[13px]">{s.name}</span>
                    <Tag tone={s.role === 'owner' ? 'gold' : s.role === 'freelance' ? 'amber' : 'neutral'}>
                      {roleLabel(s.role)}
                    </Tag>
                  </li>
                ))}
              </ul>
            </Card>
            <p className="mt-2 text-[11px] leading-relaxed text-stone">
              フリーランス顧客はシェアサロン情報分離設定により他スタッフから非表示にできます。
              招待はメール / QRコード、退職時はカルテ所有権処理を実行します。
            </p>
          </div>

          <div className="mt-8">
            <SectionLabel>データ管理</SectionLabel>
            <Card className="p-5">
              <p className="mb-3 flex items-center gap-2 text-[13px]">
                接続モード：
                {isSupabaseConfigured ? (
                  <Tag tone="sage">Supabase（クラウド）</Tag>
                ) : (
                  <Tag tone="amber">ローカル（この端末のみ）</Tag>
                )}
              </p>
              <p className="text-[13px] leading-relaxed text-ink-soft">
                データはこの端末（ブラウザ）に自動保存されます
                {hasSavedData() ? '（保存データあり）' : ''}。
                複数端末での共有・バックアップは Supabase 接続（docs/golive.md）で有効になります。
              </p>
              <Button
                variant="danger"
                className="mt-4"
                onClick={() => {
                  if (window.confirm('保存されたデータをすべて削除し、初期デモデータに戻します。よろしいですか？')) {
                    resetDb()
                  }
                }}
              >
                データを初期化（デモデータに戻す）
              </Button>
            </Card>
          </div>

          <div className="mt-8">
            <SectionLabel>外部連携</SectionLabel>
            <div className="space-y-3">
              <IntegrationRow name="LINE公式アカウント" desc="メッセージ送受信・予約導線・リマインド" status="connected" />
              <IntegrationRow name="n8n ワークフロー" desc="自動メッセージ・AI処理・外部予約取込" status="connected" />
              <IntegrationRow name="Googleカレンダー" desc="双方向同期" status="off" />
              <IntegrationRow name="Square 決済端末" desc="Phase 2 で接続予定" status="off" />
            </div>
          </div>
        </section>

        <section>
          <SectionLabel>メニューマスタ</SectionLabel>
          <Card>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[10px] uppercase tracking-[0.16em] text-stone">
                  <th className="px-5 py-3 font-normal">カテゴリ</th>
                  <th className="px-5 py-3 font-normal">メニュー</th>
                  <th className="px-5 py-3 text-right font-normal">所要</th>
                  <th className="px-5 py-3 text-right font-normal">価格</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {menus.map((m) => (
                  <tr key={m.id}>
                    <td className="px-5 py-3 text-stone">{m.category}</td>
                    <td className="px-5 py-3">{m.name}</td>
                    <td className="tnum px-5 py-3 text-right">{m.durationMin}分</td>
                    <td className="tnum px-5 py-3 text-right">{yen(m.price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="mt-8">
            <SectionLabel>監査ログ（個人情報閲覧・会計修正）</SectionLabel>
            <Card>
              <ul className="divide-y divide-line">
                {auditLogs.map((a) => (
                  <li key={a.id} className="px-5 py-3 text-[13px]">
                    <p>
                      <span className="text-ink">{a.actor}</span>
                      <span className="mx-2 text-gold-deep">{a.action}</span>
                      <span className="text-ink-soft">{a.target}</span>
                    </p>
                    <p className="tnum mt-0.5 text-[11px] text-stone">{format(new Date(a.at), 'yyyy.MM.dd HH:mm')}</p>
                  </li>
                ))}
              </ul>
            </Card>
            <p className="mt-2 text-[11px] text-stone">ログは1年以上保持され、オーナーのみ閲覧できます。</p>
          </div>
        </section>
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

function IntegrationRow({ name, desc, status }: { name: string; desc: string; status: 'connected' | 'off' }) {
  return (
    <Card className="flex items-center justify-between gap-4 p-4">
      <div>
        <p className="text-[13px]">{name}</p>
        <p className="mt-0.5 text-[12px] text-stone">{desc}</p>
      </div>
      {status === 'connected' ? <Tag tone="sage">連携中</Tag> : <Tag>未接続</Tag>}
    </Card>
  )
}
