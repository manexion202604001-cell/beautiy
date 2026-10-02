# beautiy
美容関係アプリ — サロン管理アプリ「SALOGIC」

## 構成 (pnpm workspace)

| ディレクトリ | 内容 | 技術 |
| --- | --- | --- |
| `api/` | バックエンドAPI | Hono / Cloudflare Workers / D1 / R2 |
| `staff/` | スタッフ向けアプリ（カルテ・顧客管理・予約） | Next.js 15 (static export) |
| `customer/` | お客様向けアプリ（予約・受付・LINE会員連携） | Next.js 15 (static export) |
| `admin/` | 管理ダッシュボード | Next.js 15 (static export) |
| `karute-entry/` | カルテ記入用静的ページ | HTML |

## セットアップ

```bash
pnpm install

pnpm dev:api        # http://localhost:8787 (wrangler.dev.toml)
pnpm dev:staff
pnpm dev:customer
pnpm dev:admin      # http://localhost:3001

pnpm build          # 全アプリをビルド
```

DBスキーマは `api/src/db/schema.sql`、追加マイグレーションは `api/src/db/migration-*.sql` です。

```bash
pnpm --filter api db:migrate:dev   # スキーマ適用（開発DB）
pnpm --filter api db:seed:dev      # シードデータ投入（開発DB）
```

## 環境設定

インフラ識別子はすべてプレースホルダーになっています。実環境で使う前に置き換えてください。

- `api/wrangler.toml` / `api/wrangler.dev.toml` — `account_id`、`database_id`、`routes` のドメイン、`[vars]` の各アプリURL
- `*/.env.production` / `*/.env.development` — `NEXT_PUBLIC_API_URL`
- `customer/.env.*` — `NEXT_PUBLIC_INTAKE_LIFF_MAP`（LINEログインチャネル client_id → LIFF ID の JSON）、`NEXT_PUBLIC_INTAKE_DEFAULT_LIFF_ID`
- APIの秘密情報は `wrangler secret put <NAME>` で設定（ローカルは `api/.dev.vars`）
  - 必須: `JWT_SECRET`
  - 任意: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `RESEND_API_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `RPI_API_KEY`, `ANTHROPIC_API_KEY`

`deploy:*` スクリプトが参照する `scripts/deploy.sh` は収録されていません。

詳細は [README-review.md](README-review.md) を参照してください。
