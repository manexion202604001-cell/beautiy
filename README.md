# BEAUTIY — サロン向けカルテ＆予約統合管理システム

美容室・理容室向けの「カルテ・予約・会計/POS・メッセージ・分析」一気通貫管理システム。
正式な要件は [docs/requirements.md](docs/requirements.md)、開発ルールは [CLAUDE.md](CLAUDE.md) を参照。

## デザイン

ミニマル×ラグジュアリー。支給ブランドパレット **Emerald & Cream** と明朝体を採用しています。

| トークン | 値 | 用途 |
|---|---|---|
| Night / Night Soft | `#0F3D34` / `#134E43` | ディープエメラルド（サイドバー・ログイン・主ボタン） |
| Porcelain | `#F7F6F1` | ページ背景（クリーム） |
| Paper Warm | `#E6F0E9` | 淡いミント面（ホバー・内側パネル） |
| Gold | `#C8A96A` | アクセント（ゴールド） |
| Ink | `#14211C` | 主要テキスト（深緑がかった墨色） |

書体は全体を明朝体（ヒラギノ明朝 / 游明朝 / Noto Serif JP）で統一。
デザイントークンは `src/styles/tokens.ts` と `src/styles/index.css`（Tailwind `@theme`）で一元管理。
チャート配色（`#134E43` / `#9A7E45`）は色覚多様性シミュレーションで識別性を確認済み。

## セットアップ

```bash
npm install
npm run dev      # 開発サーバー (http://localhost:5173)
npm run build    # 型チェック + 本番ビルド
npm test         # Vitest（空き枠計算・排他制御ロジック）
```

**スタンドアロン運用対応**: データは端末（localStorage）に自動保存され、リロード後も保持されます。
1端末運用ならサーバーなしで実店舗利用が可能です（詳細・制限は [docs/golive.md](docs/golive.md)）。
複数端末・Web予約公開・LINE連携は Supabase 接続（モードB）で有効になります。
デモログイン: `/login` で任意のスタッフを選択してサインイン。

追加済みの実務機能: 顧客の新規登録/編集/論理削除、顧客CSVエクスポート（BOM付き）、
領収書印刷（インボイス番号印字）、PWA（ホーム画面追加）、データ初期化（設定画面）。

## 実装済み画面（要件定義書 7章）

| # | 画面 | パス |
|---|---|---|
| S-01 | ログイン | `/login` |
| S-02 | ホームダッシュボード | `/` |
| S-03 | 予約カレンダー（日×スタッフ別） | `/calendar` |
| S-04 | 予約登録 / 詳細 | `/reservations/new`, `/reservations/:id` |
| S-05 | 顧客一覧 / 検索 | `/customers` |
| S-06 | 顧客カルテ詳細（警告・履歴・レシピ・メモ） | `/customers/:id` |
| S-07 | カルテ入力（構造化レシピ） | `/customers/:id/karte/new` |
| S-08 | 会計（下書き→確定・複合支払・打消し伝票） | `/checkout` |
| S-09 | レジ締め（実査・差異表示） | `/register-close` |
| S-10 | メッセージ（LINE/アプリ・自動送信表示） | `/messages` |
| S-11 | レポート（売上・顧客分析） | `/reports` |
| S-12 | 店舗設定（メニュー・権限・連携・監査ログ） | `/settings` |
| S-13 | 多店舗サマリー | `/reports` 内 |
| C-01 | 顧客向けWeb予約（空き枠自動計算） | `/booking` |
| C-02 | カウンセリングシート事前記入 | `/booking/counseling` |
| C-03 | 予約確認 / 変更 / キャンセル | `/booking/manage` |

## アーキテクチャ

```
src/
├── styles/          デザイントークン + Tailwind @theme
├── lib/
│   ├── domain/      ドメイン型定義
│   ├── api/         リポジトリ層（現在はモック。Supabase 実装に差し替え可能）
│   └── booking/     空き枠計算（純関数・テスト済み）
├── hooks/           セッション / ストア購読
├── components/      共通UI（AppShell, ui primitives）
└── pages/           画面（S-01〜S-13, C-01〜C-03）
supabase/
└── migrations/      スキーマ + RLS + 予約排他制約（EXCLUDE USING gist）
```

- **リポジトリ層**: コンポーネントは `src/lib/api/` 経由でのみデータアクセス。Supabase 移行時は同層の実装のみ差し替え。
- **排他制御**: アプリ層チェック（`findConflict`）に加え、`supabase/migrations/0001` の `EXCLUDE USING gist` 制約がDB層の最終防衛線（受け入れ基準 10-1）。
- **テナント分離 / 所有権**: 全テーブル RLS + `tenant_id` 強制、顧客の `owner_type: salon | staff` 分離ポリシー実装済み（受け入れ基準 10-3, 10-6）。
- **会計不変性**: 確定伝票は DB トリガーで UPDATE 禁止。修正は打消し伝票方式のみ。

## Supabase 接続（次フェーズ）

1. Supabase プロジェクト作成後、`supabase/migrations/` を `supabase db push` で適用
2. `.env.local` に `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` を設定
3. `src/lib/api/` のモック実装を supabase-js 実装に差し替え（IF は維持）
4. LINE・自動メッセージ・AI 処理は n8n Webhook（`n8n-gateway` Edge Function）に委譲
