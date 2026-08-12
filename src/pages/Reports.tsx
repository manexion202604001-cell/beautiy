import { Card, PageHeader, SectionLabel, Stat, yen } from '../components/ui'

/**
 * S-11 レポート（売上・顧客分析） / S-13 多店舗サマリー
 * チャート配色は CVD 検証済み: gold #B8862F / aubergine #7A5A9E（白面・コントラスト3:1以上）
 */

const CHART_GOLD = '#B8862F'
const CHART_AUBERGINE = '#7A5A9E'

const monthly = [
  { label: '3月', service: 1832, product: 214 },
  { label: '4月', service: 1954, product: 189 },
  { label: '5月', service: 2103, product: 246 },
  { label: '6月', service: 1876, product: 201 },
  { label: '7月', service: 2287, product: 268 },
  { label: '8月', service: 1490, product: 172 },
] // 千円

const staffSales = [
  { name: '真行寺 蓮', amount: 1420, nominated: 62 },
  { name: '桐生 美月', amount: 1180, nominated: 48 },
  { name: '早乙女 汐里', amount: 890, nominated: 31 },
  { name: '氷室 隼', amount: 640, nominated: 27 },
] // 千円

const customerMix = [
  { label: '3月', repeat: 118, fresh: 24 },
  { label: '4月', repeat: 124, fresh: 31 },
  { label: '5月', repeat: 131, fresh: 28 },
  { label: '6月', repeat: 119, fresh: 22 },
  { label: '7月', repeat: 142, fresh: 35 },
  { label: '8月', repeat: 96, fresh: 18 },
]

export function Reports() {
  const totalThisMonth = (monthly[5].service + monthly[5].product) * 1000
  return (
    <div>
      <PageHeader eyebrow="Analytics" title="レポート" />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="今月売上（暫定）" value={yen(totalThisMonth)} sub="技術+店販" />
        <Stat label="平均客単価" value={yen(13840)} sub="直近30日" />
        <Stat label="リピート率" value="84.2%" sub="90日以内再来店" />
        <Stat label="指名率" value="58.6%" sub="今月会計ベース" />
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <section>
          <SectionLabel>月次売上（技術 / 店販・千円）</SectionLabel>
          <Card className="p-5">
            <MonthlySalesChart />
            <Legend
              items={[
                { label: '技術売上', color: CHART_GOLD },
                { label: '店販売上', color: CHART_AUBERGINE },
              ]}
            />
          </Card>
        </section>

        <section>
          <SectionLabel>来店構成（リピート / 新規・人）</SectionLabel>
          <Card className="p-5">
            <CustomerMixChart />
            <Legend
              items={[
                { label: 'リピート', color: CHART_GOLD },
                { label: '新規', color: CHART_AUBERGINE },
              ]}
            />
          </Card>
        </section>

        <section>
          <SectionLabel>スタッフ別売上（今月・千円）</SectionLabel>
          <Card className="p-5">
            <StaffSalesChart />
          </Card>
        </section>

        <section>
          <SectionLabel>系列店舗サマリー（多店舗ダッシュボード）</SectionLabel>
          <Card>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[10px] uppercase tracking-[0.16em] text-stone">
                  <th className="px-5 py-3 font-normal">店舗</th>
                  <th className="px-5 py-3 text-right font-normal">今月売上</th>
                  <th className="px-5 py-3 text-right font-normal">予約数</th>
                  <th className="px-5 py-3 text-right font-normal">リピート率</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                <tr>
                  <td className="px-5 py-3.5">表参道（本店）</td>
                  <td className="tnum px-5 py-3.5 text-right">{yen(1662000)}</td>
                  <td className="tnum px-5 py-3.5 text-right">114</td>
                  <td className="tnum px-5 py-3.5 text-right">84.2%</td>
                </tr>
                <tr>
                  <td className="px-5 py-3.5 text-stone">代官山（準備中）</td>
                  <td className="tnum px-5 py-3.5 text-right text-stone">—</td>
                  <td className="tnum px-5 py-3.5 text-right text-stone">—</td>
                  <td className="tnum px-5 py-3.5 text-right text-stone">—</td>
                </tr>
              </tbody>
            </table>
          </Card>
        </section>
      </div>
      <p className="mt-5 text-[11px] text-stone">
        歩合集計データ（スタッフ別売上・指名数）はCSVエクスポートに対応します。キャンセル・削除済み顧客は集計から除外されています。
      </p>
    </div>
  )
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="mt-3 flex gap-5">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-2 text-[11px] text-ink-soft">
          <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  )
}

const W = 440
const H = 180
const PAD = { top: 22, right: 8, bottom: 24, left: 8 }

/** 月次売上: 積み上げ棒（技術+店販）。セグメント間 2px ギャップ、上端 4px 丸め */
function MonthlySalesChart() {
  const max = Math.max(...monthly.map((m) => m.service + m.product))
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const band = innerW / monthly.length
  const barW = Math.min(34, band * 0.5)
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="月次売上の積み上げ棒グラフ">
      <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + innerH} y2={PAD.top + innerH} stroke="#E7E3DA" />
      {monthly.map((m, i) => {
        const x = PAD.left + band * i + (band - barW) / 2
        const total = m.service + m.product
        const svcTop = y(m.service)
        const prodTop = y(total)
        return (
          <g key={m.label} className="transition-opacity hover:opacity-80">
            <title>{`${m.label}: 技術 ${m.service}千円 / 店販 ${m.product}千円`}</title>
            <rect x={x} y={svcTop} width={barW} height={PAD.top + innerH - svcTop} fill={CHART_GOLD} rx={0} />
            <rect x={x} y={prodTop} width={barW} height={svcTop - prodTop - 2} fill={CHART_AUBERGINE} rx={4} />
            <text x={x + barW / 2} y={prodTop - 6} textAnchor="middle" className="fill-[#45413A] text-[10px]">
              {total.toLocaleString()}
            </text>
            <text x={x + barW / 2} y={H - 8} textAnchor="middle" className="fill-[#8C867B] text-[10px]">
              {m.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** 来店構成: 積み上げ棒（リピート+新規） */
function CustomerMixChart() {
  const max = Math.max(...customerMix.map((m) => m.repeat + m.fresh))
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const band = innerW / customerMix.length
  const barW = Math.min(34, band * 0.5)
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="月別の新規・リピート来店数">
      <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + innerH} y2={PAD.top + innerH} stroke="#E7E3DA" />
      {customerMix.map((m, i) => {
        const x = PAD.left + band * i + (band - barW) / 2
        const total = m.repeat + m.fresh
        const repTop = y(m.repeat)
        const totTop = y(total)
        return (
          <g key={m.label} className="transition-opacity hover:opacity-80">
            <title>{`${m.label}: リピート ${m.repeat}人 / 新規 ${m.fresh}人`}</title>
            <rect x={x} y={repTop} width={barW} height={PAD.top + innerH - repTop} fill={CHART_GOLD} />
            <rect x={x} y={totTop} width={barW} height={repTop - totTop - 2} fill={CHART_AUBERGINE} rx={4} />
            <text x={x + barW / 2} y={totTop - 6} textAnchor="middle" className="fill-[#45413A] text-[10px]">
              {total}
            </text>
            <text x={x + barW / 2} y={H - 8} textAnchor="middle" className="fill-[#8C867B] text-[10px]">
              {m.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** スタッフ別売上: 横棒（単一系列 gold） */
function StaffSalesChart() {
  const max = Math.max(...staffSales.map((s) => s.amount))
  const rowH = 40
  const labelW = 92
  const chartW = W - labelW - 60
  return (
    <svg viewBox={`0 0 ${W} ${staffSales.length * rowH}`} className="w-full" role="img" aria-label="スタッフ別売上の横棒グラフ">
      {staffSales.map((s, i) => {
        const barLen = (s.amount / max) * chartW
        const cy = i * rowH + rowH / 2
        return (
          <g key={s.name} className="transition-opacity hover:opacity-80">
            <title>{`${s.name}: ${s.amount}千円 / 指名 ${s.nominated}件`}</title>
            <text x={0} y={cy + 3.5} className="fill-[#45413A] text-[11px]">
              {s.name}
            </text>
            <rect x={labelW} y={cy - 7} width={barLen} height={14} fill={CHART_GOLD} rx={4} />
            <text x={labelW + barLen + 8} y={cy + 3.5} className="fill-[#45413A] text-[11px]">
              {s.amount.toLocaleString()}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
