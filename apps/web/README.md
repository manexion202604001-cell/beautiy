# @salon/web — Salon OS フロントエンド

スタッフ向け管理画面（`/app`）と、お客様向け予約画面（`/book/:shopSlug` ほか）を1つの SPA で提供します。
API（`apps/api`）の `/v1` を呼び出します。UI・ブランドは本プロジェクト独自のデザインです（要件 0.2）。

## 技術スタック

| 用途 | ライブラリ |
|---|---|
| ビルド | Vite 8 + `@vitejs/plugin-react` |
| UI | React 19 / TypeScript (strict) / Tailwind CSS v4（`@tailwindcss/vite`） |
| ルーティング | React Router 8（データルーター `createBrowserRouter`、ルート単位の lazy 分割） |
| サーバー状態 | TanStack Query 5 |
| 日付 | Intl + `@date-fns/tz`（店舗タイムゾーン表示。既定 Asia/Tokyo） |
| バリデーション | zod（`src/lib/form.ts` の軽量フォームフック） |
| テスト | Vitest + Testing Library（単体）、Playwright（E2E・スクリーンショット） |

## 起動方法

```bash
# 0) 依存関係
pnpm install

# 1) API（別ターミナル）— DB をマイグレーションしてデモデータを投入
cd apps/api
DATABASE_URL=postgres://salon:salon@localhost:5432/salon pnpm db:migrate
DATABASE_URL=postgres://salon:salon@localhost:5432/salon pnpm db:seed
DATABASE_URL=postgres://salon:salon@localhost:5432/salon PORT=4100 DEV_EXPOSE_OTP=true pnpm dev

# 2) Web
pnpm --filter @salon/web dev        # http://localhost:5173 （/v1 → http://localhost:4100 にプロキシ）
```

デモアカウント（パスワードはすべて `password-1234`）:

| ロール | メール |
|---|---|
| オーナー | owner@example.com |
| 店長 | manager@example.com |
| スタイリスト | stylist1@example.com / stylist2@example.com / stylist3@example.com |
| 受付 | reception@example.com |

お客様向け: `http://localhost:5173/book/shibuya` / `http://localhost:5173/book/omotesando`、マイページ `http://localhost:5173/my/shibuya`。
開発ビルドでは「LINEでログイン（開発用モック）」ボタンが表示され、API の `LINE_DRIVER=mock` が受け付ける `mock:<userId>:<name>` 形式の ID トークンを送信します。
電話番号/メールの確認コードは API の `DEV_EXPOSE_OTP=true` のとき画面に表示されます。

### 環境変数（`.env.example`）

| 変数 | 既定 | 説明 |
|---|---|---|
| `VITE_API_PROXY` | `http://localhost:4100` | 開発サーバー/preview の `/v1` プロキシ先 |
| `VITE_API_BASE_URL` | `/v1` | ブラウザが呼ぶ API のベースパス（本番は同一オリジンのリバースプロキシを想定） |
| `VITE_LINE_MOCK` | （dev のみ true） | 本番ビルドで LINE モックログインを表示する |

## スクリプト

| コマンド | 内容 |
|---|---|
| `pnpm --filter @salon/web dev` | 開発サーバー |
| `pnpm --filter @salon/web build` | 型チェック + 本番ビルド（`dist/`） |
| `pnpm --filter @salon/web preview` | ビルド成果物のプレビュー（`/v1` プロキシ付き） |
| `pnpm --filter @salon/web typecheck` | `tsc --noEmit` |
| `pnpm --filter @salon/web lint` | ESLint（flat config） |
| `pnpm --filter @salon/web test` | Vitest 単体テスト |
| `pnpm --filter @salon/web test:e2e` | Playwright E2E スモーク（任意） |
| `pnpm --filter @salon/web screenshots` | 主要画面のスクリーンショット（`e2e/screenshots/`、git 管理外） |

### E2E の前提条件

1. API がシード済み DB で起動していること（既定 `http://localhost:4100`、`DEV_EXPOSE_OTP=true` 推奨）。
2. Web 開発サーバーは未起動なら Playwright が `vite --port 5173` で自動起動します（`E2E_BASE_URL` を指定すると既存サーバーを利用）。
3. Chromium: `PLAYWRIGHT_BROWSERS_PATH`（例 `/opt/pw-browsers`）にインストール済みのブラウザを使用します。`@playwright/test` は 1.56.1（chromium-1194）に固定しています。別のバイナリを使う場合は `PW_CHROMIUM_PATH=/path/to/chrome`。
4. `playwright install` は不要です。

| テスト | 内容 |
|---|---|
| `e2e/staff.spec.ts` | スタッフログイン → カレンダーにシード済み予約が表示 → 予約作成（顧客検索・メニュー・空き枠・Idempotency-Key 付き登録） |
| `e2e/booking.spec.ts` | `/book/<slug>` でゲスト予約（メニュー→スタッフ→日時→お客様情報→確認→完了→管理リンク） |
| `e2e/screenshots.spec.ts` | `SCREENSHOTS=1` のときのみ実行。デスクトップ/iPad/スマホの主要画面を保存 |

> API の `/v1/auth/refresh` は IP 単位で 20回/分 に制限されています。ページを完全リロードするたびにリフレッシュするため、
> 長いテストは `e2e/helpers.ts` の `nav()`（SPA 内遷移）を使ってください。

## 画面一覧

### スタッフ管理画面（`/app`、要ログイン・権限で表示/操作を制御）

| パス | 画面 |
|---|---|
| `/login` | ログイン（複数法人の選択、MFA 確認コード） |
| `/signup` | 新規法人登録（法人・最初の店舗・オーナー） |
| `/invite/:token` | スタッフ招待の受諾（パスワード設定） |
| `/app` | ダッシュボード（本日の予約・KPI・要対応: 仮予約承認／無断キャンセル候補） |
| `/app/calendar` | 予約カレンダー（日: スタッフ列・15分グリッド・勤務時間外の網掛け・現在時刻線、週: 日別リスト）。空き時間クリックで予約作成、予約クリックで詳細ドロワー（ステータス操作・変更・履歴） |
| `/app/customers` | 顧客一覧（検索・絞り込み・並び替え・もっと見る・CSV出力） |
| `/app/customers/new` | 顧客登録（重複候補の提示） |
| `/app/customers/:id` | 顧客詳細（統計、プロフィール、来店履歴、タイムライン、メモ（共有/自分のみ）、タグ、重複候補・統合・Undo） |
| `/app/customers/duplicates` | 名寄せ（重複ペアの統合／別人として除外） |
| `/app/menus` | メニュー（共通/店舗独自、店舗別上書き、設備条件、担当スタッフ）、カテゴリ、クーポン、席・設備 |
| `/app/staff` | スタッフ一覧・追加（招待リンク/初期パスワード/ログインなし） |
| `/app/staff/:id` | スタッフ詳細（基本情報・公開プロフィール、権限変更（確認＋監査）、所属店舗・異動、勤務パターン） |
| `/app/staff/roles` | 権限ロール（権限マトリクス、カスタムロール作成/編集/削除） |
| `/app/shifts` | シフト（スタッフ×曜日グリッド、一括保存、前週コピー） |
| `/app/settings` | 店舗設定（基本情報・オンライン予約、予約/リマインド/会計/口コミ設定、営業時間、休業日カレンダー、法人設定・インボイス番号） |
| `/app/soon/:feature` | 準備中の機能（会計・カルテ・メッセージ・配信・口コミ・商品/EC・分析・外部連携・運用/監査）。サイドバーでは「準備中」として無効表示 |

### お客様向け画面（ログイン不要・スマホ優先・LINE アプリ内ブラウザ対応）

| パス | 画面 |
|---|---|
| `/book/:shopSlug` | 予約フロー: メニュー → スタッフ（指名なし/指名） → 日時（日付ストリップ＋空き枠） → お客様情報（ゲスト / LINE / 電話・メールOTP） → 確認 → 完了（予約番号・カレンダー追加 .ics・管理リンク）。`utm_*` / `ref` を予約に記録、`clientRequestId` で二重送信を防止、`SLOT_UNAVAILABLE` 時は空き枠を再取得して選び直し |
| `/b/manage/:token` | 予約確認・キャンセル（期限表示） |
| `/my`, `/my/:shopSlug` | マイページ（LINE/OTP ログイン、今後/過去の予約、日時変更・キャンセル、お客様情報、配信設定） |

## ディレクトリ構成

```
src/
  main.tsx / router.tsx       エントリ・ルート定義（lazy 分割）
  index.css                   デザイントークン（CSS 変数・ライト/ダーク）
  lib/
    api.ts                    fetch ラッパー（ベースURL・JSON・Authorization・X-Shop-Id・Idempotency-Key・
                              401 時のリフレッシュ（single-flight + Web Locks でタブ間直列化）・ApiError）
    auth.tsx                  認証コンテキスト（アクセストークンはメモリ、リフレッシュトークンは localStorage、
                              /me、can('customer.write')、店舗切替の永続化）
    session.ts / storage.ts   セッションストア（try/catch 付き localStorage）・顧客トークン
    format.ts / time.ts       ¥表記・JST 日時・相対日付 / タイムゾーン変換
    form.ts                   zod フォームフック
    ics.ts / theme.ts / hooks.ts
  api/*.ts                    ドメイン別のエンドポイント関数・型・React Query フック
  components/ui/*             Button, Input/Select/Textarea/Checkbox/Switch/Segmented(Field), Dialog/Drawer, Table,
                              Badge/TagChip, Tabs, Toast, EmptyState/ErrorState/Alert, Spinner, LoadMore(もっと見る),
                              ConfirmDialog, DateNav, Menu, Icon
  components/layout/*         サイドバー・ヘッダー（店舗/法人切替、ユーザーメニュー）・ルートガード
  components/appointments/*   予約作成ドロワー、予約詳細ドロワー、顧客タイプアヘッド、メニュー/空き枠ピッカー
  routes/                     画面（auth / app / public）
e2e/                          Playwright
```

## 設計メモ

- **タイムゾーン**: API の日時は UTC。表示・日付境界は店舗のタイムゾーン（`shop.timezone`）で計算します（`lib/time.ts`）。
- **楽観ロック**: 予約の変更・ステータス操作は `version` を送り、`VERSION_CONFLICT` は「最新を表示」付きで案内します。
- **冪等性**: 予約作成/変更/ステータス操作、顧客作成、統合は操作ごとに生成した `Idempotency-Key` を送ります（ネットワークエラー時の再送では同じキーを再利用し、サーバー応答があった場合は新しいキーに切り替え）。公開予約は `clientRequestId` を使用。
- **権限**: `/v1/me` の `permissions` でナビゲーションとボタンを出し分けます（最終的な認可は API）。
- **アクセシビリティ**: ラベル関連付け、`aria-invalid`/`aria-describedby`、モーダルのフォーカストラップと Esc、タブ/メニュー/コンボボックスのキーボード操作、スキップリンク、`prefers-reduced-motion` 対応。
- **テーマ**: OS 設定に追従し、ユーザーメニューからライト/ダークを固定できます（`localStorage: salon.theme`）。
