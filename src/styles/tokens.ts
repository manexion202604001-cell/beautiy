/**
 * デザイントークン — Minimal Luxury
 * 高級メゾンの世界観: 磁器のようなアイボリー地 / 墨色 / シャンパンゴールド
 * KICKOFF_PROMPT の「デザイントークンを src/styles/tokens.ts として支給」に対応する正式トークン。
 * Tailwind 側 (@theme in index.css) と同期させること。
 */

export const colors = {
  /** ページ背景 — 温かみのある磁器色 */
  porcelain: '#F6F4EF',
  /** カード・面 */
  paper: '#FFFFFF',
  paperWarm: '#FBFAF6',
  /** 主要テキスト — 墨色 */
  ink: '#1B1916',
  inkSoft: '#45413A',
  /** 補助テキスト */
  stone: '#8C867B',
  /** 罫線 */
  line: '#E7E3DA',
  lineStrong: '#D6D0C3',
  /** アクセント — シャンパンゴールド */
  gold: '#A18A5B',
  goldDeep: '#82704A',
  goldTint: '#F1ECE0',
  /** ダーク面（ナイトヘッダー・ログイン） */
  night: '#171512',
  nightSoft: '#26231E',
  /** 状態色 — 彩度を抑えた高級トーン */
  sage: '#6F7D63',
  sageTint: '#EEF1EA',
  clay: '#A05248',
  clayTint: '#F5EAE8',
  amber: '#B08A3E',
  amberTint: '#F6EFE0',
} as const

export const font = {
  display: `'Cormorant Garamond', Georgia, 'Hiragino Mincho ProN', 'Yu Mincho', YuMincho, serif`,
  body: `'Avenir Next', Avenir, 'Helvetica Neue', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', system-ui, sans-serif`,
} as const

export const radius = {
  sm: '2px',
  md: '4px',
  lg: '8px',
} as const

export const spacing = {
  page: '1.25rem',
  section: '2rem',
} as const

export type ColorToken = keyof typeof colors
