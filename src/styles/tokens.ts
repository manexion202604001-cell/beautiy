/**
 * デザイントークン — Emerald & Cream（支給ブランドパレット）
 * 基調5色: #0F3D34 / #134E43 / #E6F0E9 / #F7F6F1 / #C8A96A
 * KICKOFF_PROMPT の「デザイントークンを src/styles/tokens.ts として支給」に対応する正式トークン。
 * Tailwind 側 (@theme in index.css) と同期させること。
 */

export const colors = {
  /** ページ背景 — クリーム #F7F6F1 */
  porcelain: '#F7F6F1',
  /** カード・面 */
  paper: '#FFFFFF',
  /** 淡いミント面（ホバー・内側パネル）#E6F0E9 */
  paperWarm: '#E6F0E9',
  /** 主要テキスト — 深緑がかった墨色 */
  ink: '#14211C',
  inkSoft: '#3D4B45',
  /** 補助テキスト */
  stone: '#75817A',
  /** 罫線 */
  line: '#DFE7E1',
  lineStrong: '#C8D3CB',
  /** アクセント — ゴールド #C8A96A */
  gold: '#C8A96A',
  goldDeep: '#9A7E45',
  goldTint: '#F2EBDA',
  /** ダーク面 — ディープエメラルド #0F3D34 / #134E43 */
  night: '#0F3D34',
  nightSoft: '#134E43',
  /** 状態色 — 彩度を抑えた高級トーン */
  sage: '#4A7A5C',
  sageTint: '#E6F0E9',
  clay: '#A05248',
  clayTint: '#F5EAE8',
  amber: '#A8853E',
  amberTint: '#F4EDDC',
} as const

export const font = {
  display: `'Cormorant Garamond', Georgia, 'Hiragino Mincho ProN', 'Yu Mincho', YuMincho, 'Noto Serif JP', serif`,
  /** 本文も明朝体で統一（高級ブランドトーン） */
  body: `'Hiragino Mincho ProN', 'Yu Mincho', YuMincho, 'Noto Serif JP', Georgia, 'Times New Roman', serif`,
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
