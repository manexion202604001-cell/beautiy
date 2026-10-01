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
| `e2e/pos.spec.ts` | レジ開局 → 会計待ちの予約から「会計する」→ 現金（テンキー・お釣り）→ 確定 → レシート発行・印刷用HTML → 日報 |
| `e2e/pos-advanced.spec.ts` | 予約なし会計: メニュー＋バーコード商品＋10%値引＋担当者配分50/50 → カード＋現金の分割払い → 一部返金 → 別会計の取消 → レジ締め（金種） |
| `e2e/commerce.spec.ts` | 商品登録（画像アップロード）・EC在庫入荷 → ストア → 商品 → カート → LINEモックでログイン → 注文（決済待ち）→ スタッフの注文一覧に表示 → モック決済完了 → 発送 → マイページの注文 |
| `e2e/reviews.spec.ts` | 口コミ依頼（リンク＋QR）→ お客様が投稿（再利用不可）→ スタッフが公開・返信 |
| `e2e/kartes.spec.ts` | カルテ作成（テンプレート項目・薬剤・写真）→ 共有ページ（薬剤は非表示）→ 店頭で同意書＋署名 → 改ざん検証 → 事前問診リンク → お客様が回答 |
| `e2e/screenshots-pass2.spec.ts` | `SCREENSHOTS=1` のときのみ実行。会計・カルテ・口コミ・商品/EC と公開ページをデスクトップ/iPad/スマホで保存 |
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
| `/app/pos` | 会計トップ: レジ（開局＝釣銭準備金（金額/金種）・入金/出金・レジ締め＝金種ごとの実査→想定残高との差額）、本日の売上、会計待ちの予約（「会計する」）、本日の会計、予約なしの新規会計 |
| `/app/pos/checkout/:transactionId` | お会計: 明細（メニュー・商品（名称/SKU/バーコード検索、スキャナの Enter で即追加）・値引（金額/％）・クーポン・指名料・調整）、明細ごとの単価/数量/値引/税率編集、担当者配分（役割・配分％・指名、合計100%）、主担当・指名・顧客の変更、ポイント利用、合計と税率別内訳（API計算）、支払（現金テンキー＋お預かり候補＋お釣り、カード、電子マネー、QR、店舗独自決済、分割払い、支払取消）、確定（Idempotency-Key）、レシート/領収書の発行→印刷用HTMLを新しいタブで表示、取消（`pos.void`）・返金/返品（`pos.refund`、在庫戻し数量）、破棄。楽観ロック（`VERSION_CONFLICT`）は最新を再読込 |
| `/app/pos/transactions` | 会計履歴（期間・状態・担当で絞り込み、会計CSV / 明細CSV（`export.data`）） |
| `/app/pos/daily` | 日報（純売上・客単価・値引・返金・ポイント、支払方法別、新規/再来/未登録/指名、税率別、担当者別（施術/店販）、レジ差額）。`sales.read_own` のみの場合は自分の売上のみ |
| `/app/kartes` | カルテ一覧（来店日の新しい順、顧客・担当・期間で絞り込み） |
| `/app/kartes/new`, `/app/kartes/:id` | カルテ編集: テンプレート項目（text/textarea/number/select/multiselect/checkbox/date/カラー配合、「共有」項目の表示）、使用薬剤、ホームケア（アドバイス＋おすすめ商品）、スタッフメモ、前回カルテの複製、写真（ビフォー/アフター/写真/スケッチ、presign→PUT→complete、署名付きURLでプレビュー、共有可否・キャプション編集）、お客様への共有（期限・通知チャネル、リンク＋QR、再発行・取消）。版の競合は「最新を読み込む」で案内 |
| `/app/kartes/forms` | 問診・同意書フォーム（カウンセリング/同意書/事前問診）: 作成・編集（質問項目ビルダー、顧客情報への反映、署名必須、本文）、プレビュー、版の履歴、アーカイブ。回答済みの版を編集すると新しい版が作成されます |
| `/app/customers/:id?tab=kartes` / `?tab=forms` | 顧客詳細の「カルテ」タブ（一覧・新規・前回複製）と「書類」タブ（店頭で記入＋キャンバス署名（PNG data URL）、リンク送信、詳細: 回答・署名・改ざん検証・印刷用HTML・無効化） |
| `/app/reviews` | 口コミ: 平均・分布・承認待ち/未返信の集計、絞り込み（店舗・スタッフ・評価・状態・媒体・返信）、公開/非表示、返信（Google口コミはGBPへ反映状態を表示）、口コミ依頼の作成（リンク＋QR、送信の有無）、依頼履歴、Google口コミ取り込み |
| `/app/commerce` | 商品・EC: 商品（登録/編集/削除、画像アップロード、税込/税抜・税率・原価・SKU・バーコード・法人共通/店舗・EC販売・在庫管理）、在庫（店舗別＋EC倉庫、入荷/棚卸調整/移動/返品、発注点、入出庫履歴）、在庫僅少、EC注文（出荷準備→発送（配送業者・伝票番号）→配達完了、キャンセル（返金））、売上（商品別/スタッフ別、EC/店販）、お客様への商品共有（紹介リンク） |
| `/app/soon/:feature` | 準備中の機能（メッセージ・配信・分析・外部連携・運用/監査）。サイドバーでは「準備中」として無効表示 |

予約詳細ドロワーには「会計する」「カルテを書く」「事前問診を送る」、ダッシュボードの本日の予約（来店・施術中・完了）には「会計」ボタンがあります。

### お客様向け画面（ログイン不要・スマホ優先・LINE アプリ内ブラウザ対応）

| パス | 画面 |
|---|---|
| `/book/:shopSlug` | 予約フロー: メニュー → スタッフ（指名なし/指名） → 日時（日付ストリップ＋空き枠） → お客様情報（ゲスト / LINE / 電話・メールOTP） → 確認 → 完了（予約番号・カレンダー追加 .ics・管理リンク）。`utm_*` / `ref` を予約に記録、`clientRequestId` で二重送信を防止、`SLOT_UNAVAILABLE` 時は空き枠を再取得して選び直し |
| `/b/manage/:token` | 予約確認・キャンセル（期限表示） |
| `/my`, `/my/:shopSlug` | マイページ（LINE/OTP ログイン、今後/過去の予約、日時変更・キャンセル、ご注文（EC注文の一覧・詳細、`?tab=orders`）、お客様情報、配信設定） |
| `/book/:shopSlug/staff/:staffId`（`/s/:shopSlug/staff/:staffId`） | スタイリスト公開プロフィール（経歴・得意技術・SNS・評価・口コミ・指名して予約）。予約フローのスタッフ選択から開けます |
| `/book/:shopSlug/reviews`（`/s/:shopSlug/reviews`） | 店舗の公開口コミ（平均・分布・返信）。予約ページ上部に評価サマリーを表示 |
| `/k/:token` | 共有カルテ（お客様向けの安全な項目のみ: 写真・「共有」項目・ホームケア・おすすめ商品） |
| `/f/:token` | 事前問診・同意書の記入（署名パッド、1回限り） |
| `/review/:token`（`/r/:token`） | 口コミ投稿（星・スタッフ評価・感想・ニックネーム、1回限り。評価に応じて任意の Google 口コミ案内） |
| `/store/:shopSlug`（`/shop/:shopSlug`） | オンラインストア（カテゴリ・在庫表示・カートに追加） |
| `/store/products/:id`（`/shop/:shopSlug/products/:id`） | 商品ページ（画像・税込価格・数量）。`?ref=` の紹介コードを保持して注文に付与 |
| `/store/:shopSlug/cart` → `/checkout` → `/orders/:orderId` | カート（localStorage・店舗別、try/catch でメモリにフォールバック）→ ご購入手続き（LINE/OTP ログイン、お届け先、`idempotencyKey` をカートに保持して二重注文防止）→ 注文結果（決済待ちの間は3秒ごとに注文をポーリング、失敗時は再試行） |
| `/s/:shopSlug` | 予約ページ（`/book/:shopSlug`）へリダイレクト |

> **決済（開発環境）**: `PAYMENT_PROVIDER=mock` のモック決済は自動では完了しません（API の `POST /v1/payments/:id/mock-complete` はスタッフ権限 `order.manage` が必要で、お客様からは呼べません）。
> そのためストアの注文結果は「決済待ち」を表示して注文をポーリングし、開発ビルドではスタッフ画面「商品・EC → EC注文」の注文詳細に「モック決済を完了（開発用）」ボタンを表示します。

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
  components/forms/*          テンプレート駆動の入力項目（DynamicField）、署名パッド、QRコード（qrcode→SVG）、星評価、リンクのコピー
  routes/app/pos|kartes|reviews|commerce   会計・カルテ/書類・口コミ・商品/EC
  routes/public/store|reviews              オンラインストア・カート / 公開口コミ・スタッフプロフィール
  lib/money.ts                税率別内訳・お釣り・金種集計・担当者配分などの表示用ヘルパー（API が金額の正）
  routes/                     画面（auth / app / public）
e2e/                          Playwright
```

## 設計メモ

- **タイムゾーン**: API の日時は UTC。表示・日付境界は店舗のタイムゾーン（`shop.timezone`）で計算します（`lib/time.ts`）。
- **楽観ロック**: 予約の変更・ステータス操作は `version` を送り、`VERSION_CONFLICT` は「最新を表示」付きで案内します。
- **冪等性**: 予約作成/変更/ステータス操作、顧客作成、統合は操作ごとに生成した `Idempotency-Key` を送ります（ネットワークエラー時の再送では同じキーを再利用し、サーバー応答があった場合は新しいキーに切り替え）。公開予約は `clientRequestId` を使用。
- **権限**: `/v1/me` の `permissions` でナビゲーションとボタンを出し分けます（最終的な認可は API）。
- **アクセシビリティ**: ラベル関連付け、`aria-invalid`/`aria-describedby`、モーダルのフォーカストラップと Esc、タブ/メニュー/コンボボックスのキーボード操作、スキップリンク、`prefers-reduced-motion` 対応。
- **ファイル**: `api/files.ts` の `uploadFile()` が presign → 署名付きURLへ PUT → complete（SHA-256 チェックサム付き）を行います。ローカルストレージドライバの絶対URL（`API_BASE_URL`）は、`/v1` 同一オリジン構成ではパスに変換してプロキシ経由で扱います（`sameOriginBlobUrl`）。
- **印刷用HTML**: レシート/領収書・書類の HTML は認証付き fetch で取得し、blob URL を新しいタブで開きます（ポップアップブロック回避のためクリック時にタブを先に開く）。
- **テーマ**: OS 設定に追従し、ユーザーメニューからライト/ダークを固定できます（`localStorage: salon.theme`）。

## メッセージ・配信・分析・外部連携・運用（pass2-b）

サイドバーの「メッセージ」「配信」「分析」「外部連携」「運用・監査」を有効化しました。表示は `/v1/me` の権限で出し分けます（最終的な認可は API）。

### 画面

| パス | 画面 | 主な権限 |
|---|---|---|
| `/app/messages` | 受信箱（顧客ごとの最新メッセージ・未読バッジ・この店舗/全店舗）、スレッド（送信状態・スキップ理由・失敗の再送・既読にする）、作成欄（本文/テンプレート挿入・プレビュー・送信チャネル・AI下書き）。`?customer=<id>&draft=<purpose>` でAI下書きを開いた状態で表示 | `message.read` / `message.send` / `ai.use` |
| `/app/customers/:id?tab=messages` | 顧客詳細「メッセージ」タブ: スレッド、配信設定（全体の販促同意・チャネル別の販促/予約通知）、LINE連携QR（URLコピー・有効期限）、AIカルテ要約 | `message.read` / `customer.write` / `ai.use`+`karte.read` |
| `/app/campaigns?tab=campaigns` | キャンペーン: 下書き作成（保存済みセグメント or 条件指定・テンプレート or 本文）→ 承認 → **配信予約（対象人数の確認と同意チェックが必須）** → 配信状況（対象/送信/待機/失敗/スキップ/取消）・キャンセル | `campaign.manage` |
| `/app/campaigns?tab=segments` | セグメントビルダー（13.1 DSL の全条件・AND/OR グループ・NOT・JSON 編集切替）、対象人数とサンプルのライブプレビュー | `campaign.manage` |
| `/app/campaigns?tab=templates` | テンプレート一覧・作成/編集（変数チップ・サンプル値のライブプレビュー・不明な変数の警告）・システムテンプレートの無効化 | `template.manage`（閲覧は `message.send` / `campaign.manage` でも可） |
| `/app/campaigns?tab=automations` | 自動配信（休眠/初回未再来/来店周期/来店後/誕生月、日数・送信時刻・次回予約なし・追加セグメント条件）。作成時は停止中、有効化は確認ダイアログ、「試算（送信しない）」で対象人数とサンプル | `campaign.manage` |
| `/app/campaigns?tab=referrals` | 紹介・計測リンク（UTM・店舗・スタッフ）、統計（クリック/予約/来店/購入/売上/予約率）、QRコード・コピー | `marketing.manage` |
| `/app/campaigns?tab=sns` | SNS素材（スタイル写真/ビフォーアフター/口コミ引用）。カルテ写真は**掲載同意チェック必須**、SVG プレビュー・ダウンロード | `marketing.manage`（写真は `karte.read`） |
| `/app/analytics` | 期間（今月/先月/過去30日/過去90日/今年/指定）・店舗・比較（前期間/前年/なし）を1行のフィルタで指定（URL に保持）。タブ: 売上（日/週/月/店舗/スタッフ、増減付きの指標タイル、推移・内訳グラフ）、顧客（新規/再来/失客・来店周期分布）、リピート率（30/60/90日コホート）、LTV（経路/店舗/初回来店月・上位顧客）、メニュー構成比、スタッフ生産性（指名率・稼働率・時間あたり売上）、予約経路、AIインサイト（売上予測と信頼帯・失客リスク・おすすめアクション）。各タブに CSV 出力 | `analytics.read`。`analytics.read_own`（スタイリスト）は売上/スタッフ生産性の自分の数値のみ（他タブ・店舗別・CSV は非表示）。CSV は `export.data` |
| `/app/integrations` | 予約媒体（追加/編集: 連携先・認証情報（書き込み専用）・スタッフ/メニュー対応表・競合ルール・枠反映、接続テスト、差分/全件再同期、同期ジョブ履歴、無効化/有効化）、同期ステータス（店舗別・縮退・未解決競合・未反映枠）、競合キュー（自社優先/外部反映/手動対応・予約紐付け/無視）、LINE公式アカウント（法人/店舗単位、シークレットはマスク表示、Webhook URL、認証情報の確認） | `integration.manage` |
| `/app/ops` | 障害ダッシュボード、ジョブ/DLQ（再実行・取消・ペイロード表示）、Webhook（再処理）、ヘルス、監査ログ検索（操作者/操作の前方一致 `customer.*`/リソース/店舗/期間、カーソル、変更前後）、データエクスポート（作成→自動ポーリング→ダウンロード）、機能フラグ（法人上書き・既定に戻す） | `ops.manage` / `audit.read` / `export.data` |
| `/app`（ダッシュボード） | 売上速報（本日の確定売上・今月の売上・目標達成率・ペース）、今日のおすすめアクション、運用アラート（権限がある場合のみ） | `analytics.read` / `ai.use` / `ops.manage` |

お客様向け:

| パス | 画面 |
|---|---|
| `/unsubscribe?token=` | メールの配信停止リンク（このチャネルのみ/すべて を選んで停止） |
| `/line/link?token=`（LIFF の `?linkToken=` も可） | スタッフが発行した QR からの LINE アカウント連携。開発時は予約画面と同じモック ID トークン（`mock:<userId>:<name>`）を送信 |
| `/s/:shopSlug[/staff/:id]` | メッセージ内の短縮リンク → `/book/:shopSlug`（クエリ `ref`・`utm_*` を維持） |
| `/my/:shopSlug` 通知設定 | チャネル別（LINE/メール/SMS）の販促・予約通知の受け取り設定（`/v1/public/me/notification-preferences`） |

### 安全設計

- **送信は明示操作のみ**: キャンペーンは下書き → 承認 → 「配信予約」ダイアログ（対象人数の再確認・同意チェック）でのみ送信されます。自動配信は作成時に停止中で、有効化には確認が必要です。
- **AI は提案のみ**: AI下書きを「採用」すると本文が作成欄にコピーされるだけで、送信は担当者が行います（API も `delivery: 'manual'`）。
- 認証情報（外部連携・LINE）は書き込み専用で、画面には末尾4文字のマスクのみ表示します。
- 署名付きファイル URL（SNS素材・カルテ写真・エクスポート）は `src/lib/urls.ts` で同一オリジンの `/v1` パスに変換して表示します（API が `Cross-Origin-Resource-Policy: same-origin` を返すため）。

### グラフ

`src/components/charts/` に依存ライブラリなしの SVG グラフ（折れ線＋信頼帯・縦棒・横棒ランキング・100%積み上げ）と指標タイルを実装しています。
カテゴリ色は固定順のパレット（ライト/ダークで別ステップ、色覚多様性のバリデーション済み）、細いマーク・ヘアラインのグリッド、
ホバー/キーボード（←→）のツールチップ、全グラフに「表」表示を用意しています。

### 開発・E2E

分析画面のデータは集計テーブルから読みます。デモデータ投入後は `POST /v1/analytics/rebuild {shopId, from, to}`（`ops.manage`）を実行し、
ワーカー（`pnpm --filter @salon/api dev:worker`）でジョブを処理してください。失客リスクは `POST /v1/ai/scores/recompute` で再計算できます。

| テスト | 内容 |
|---|---|
| `e2e/messaging.spec.ts` | 顧客詳細の「メッセージ」タブからプレビュー→送信し、スレッドと受信箱に表示される |
| `e2e/campaigns.spec.ts` | セグメントをビジュアル編集（条件追加・OR 切替）し、ライブプレビューの人数を確認して保存 |
| `e2e/analytics.spec.ts` | 売上分析のタイル・折れ線/棒グラフ・ツールチップ・表表示 |
| `e2e/pass2b-screens.spec.ts` / `e2e/pass2b-flows.spec.ts` | `SCREENSHOTS=1` のときのみ。全タブのスクリーンショット（デスクトップ/スマホ/ダーク）、ダイアログ・公開ページ・スタイリスト権限の操作確認（`E2E_UNSUB_URL` 指定で配信停止ページも確認） |
| `src/routes/app/campaigns/segment-dsl.test.ts` | セグメントビルダー ⇄ DSL 変換・検証の単体テスト |


## 静的Webデモ（閲覧専用）

サーバーなしで画面を確認できるデモビルドです。実APIをデモデータで動かして記録したレスポンスを、ブラウザ内で返します（書き込みは「閲覧専用」として拒否）。日付は記録日に固定され、URLはハッシュ形式（`#/app/...`）です。

```bash
# 1. 記録: シード済みAPIを RECORD_FIXTURES 付きで起動し、全画面を巡回
RECORD_FIXTURES=/tmp/fixtures.jsonl DATABASE_URL=... PORT=4100 DEV_EXPOSE_OTP=true pnpm --filter @salon/api dev
DEMO_CRAWL=1 pnpm --filter @salon/web exec playwright test e2e/demo-crawl.spec.ts
# 2. フィクスチャ生成（src/demo/fixtures.json）
python3 apps/web/scripts/build-demo-fixtures.py /tmp/fixtures.jsonl 2026-10-01
# 3. ビルド（dist-demo/）
pnpm --filter @salon/web build:demo
```
