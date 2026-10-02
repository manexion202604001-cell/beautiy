# beautiy
美容関係アプリ — サロン管理アプリ「SALOGIC」

## 構成 (pnpm workspace)

| ディレクトリ | 内容 | 技術 | ローカルポート |
| --- | --- | --- | --- |
| `api/` | バックエンドAPI | Hono / Cloudflare Workers / D1 / R2 | 8787 |
| `customer/` | お客様向けアプリ（予約・受付・LINE会員連携） | Next.js 15 (static export) | 3000 |
| `admin/` | 管理ダッシュボード | Next.js 15 (static export) | 3001 |
| `staff/` | スタッフ向けアプリ（カルテ・顧客管理・予約） | Next.js 15 (static export) | 3002 |
| `karute-entry/` | カルテ記入用静的ページ | HTML | - |

## ローカル開発（Cloudflareアカウント不要）

```bash
pnpm install

# 1. API の秘密情報とローカルDB
cp api/.dev.vars.example api/.dev.vars
pnpm db:setup:local          # schema.sql + seed.sql をローカルD1に投入（作り直しは db:reset:local）

# 2. フロントエンドの接続先をローカルAPIに
for app in staff admin customer; do cp $app/.env.example $app/.env.local; done

# 3. 起動（それぞれ別ターミナル）
pnpm dev:api:local
pnpm dev:staff
pnpm dev:admin
pnpm dev:customer
```

シードデータのログイン:

| アプリ | メール | パスワード |
| --- | --- | --- |
| staff / admin | `owner@example.com`（オーナー）, `manager@example.com`, `sato@example.com`, `yamada@example.com` | `password123` |
| admin（システム管理者） | `admin@example.com` | `password123` |
| customer | `hanako@example.com`, `taro@example.com`, `misaki@example.com` | `customer123` |

`pnpm dev:api` は wrangler.dev.toml の **リモート** D1 に接続します（Cloudflareログインが必要）。

## チェック

```bash
pnpm typecheck                 # 全パッケージの型チェック
pnpm lint                      # フロントエンドの ESLint
pnpm --filter api test         # API のテスト（Node 22 以上）
pnpm build                     # 全アプリのビルド
```

同じ内容を GitHub Actions（`.github/workflows/ci.yml`）で実行します。
`api/test/schema.test.ts` は、API内のすべてのSQLが `schema.sql` に対して実行可能か（存在しないカラム・テーブルを参照していないか）を検査します。

## データベース

- `api/src/db/schema.sql` — **完全なスキーマ**。新規環境はこれだけで構築できます（`pnpm db:migrate` / `db:migrate:dev`）。
- `api/src/db/migration-*.sql` — 既存DBを更新するための差分。スキーマを変える時は `schema.sql` と migration の両方を更新してください。
- 既存の本番/開発DBには `migration-missing-columns.sql` の適用が必要な場合があります（コードが参照しているのに定義が無かったカラム・`line_sessions` テーブル）。既に存在するカラムは `duplicate column name` エラーになるので、その行を除いて実行してください。
- `seed.sql` — ローカル開発用のデモデータ（予約は実行日のJST基準で作られます）。

## デプロイ

```bash
pnpm --filter api publish:dev     # API (wrangler.dev.toml)
pnpm --filter api publish         # API (wrangler.toml)

pnpm deploy:staff:dev             # フロントエンド → Cloudflare Pages（scripts/deploy.sh）
pnpm deploy:staff                 # staff / admin / customer / karute-entry
```

`scripts/deploy.sh` は `.env.development`（dev）/ `.env.production`（prod）でビルドし、`wrangler pages deploy` します。
Pagesプロジェクト名は既定で `salon-<app>` / `salon-<app>-dev`。`PAGES_PROJECT_STAFF` などで上書きできます。
`karute-entry` は `KARUTE_ENTRY_API_URL` を指定すると、index.html 内のAPI URLを置き換えてデプロイします。

## 本番運用に必要な設定

インフラ識別子はプレースホルダーです。実環境で使う前に置き換えてください。

- `api/wrangler.toml` / `api/wrangler.dev.toml` — `account_id`、`database_id`、`routes` のドメイン、`[vars]` の各アプリURL
- `api/src/index.ts` — CORS 許可オリジン（`*.example.com` のプレースホルダー）
- `*/.env.production` / `*/.env.development` — `NEXT_PUBLIC_API_URL`
- `customer/.env.*` — `NEXT_PUBLIC_STORE_ID`（URLに store_id が無い時の店舗）、`NEXT_PUBLIC_INTAKE_LIFF_MAP`（LINEログインチャネル client_id → LIFF ID の JSON）、`NEXT_PUBLIC_INTAKE_DEFAULT_LIFF_ID`
- `api/src/routes/customerAuth.ts` などの Cookie `domain`（`.example.com`）
- APIの秘密情報は `wrangler secret put <NAME>` で設定（ローカルは `api/.dev.vars`）
  - 必須: `JWT_SECRET`
  - 任意: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `RESEND_API_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `RPI_API_KEY`, `ANTHROPIC_API_KEY`
- 店舗ごとのLINE設定（チャネルID/シークレット/アクセストークン/LIFF ID）は管理画面の店舗設定から登録
- お客様アプリの「LINEでログイン」には、LINE Developers のコールバックURLに `<お客様アプリURL>/auth/line/callback` の登録が必要

## このリポジトリに含まれないもの

- サロンボード同期クライアント（Raspberry Pi 側。API側は `/api/salonboard`、認証は `RPI_API_KEY`）
- ホットペッパー予約メールの取り込み（`hpb_emails` テーブルへ書き込む処理）

詳細は [README-review.md](README-review.md) を参照してください。
