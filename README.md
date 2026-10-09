# Salon OS — LiME型 美容サロンOS

美容サロン業務を **集客 → 予約 → 顧客 → 施術 → カルテ → 会計 → 口コミ → 再来店** まで一気通貫で管理するマルチテナント SaaS。
LINE を顧客接点とし（専用アプリ不要）、個人美容師から多店舗法人まで同一基盤で運用できます。

> 要件定義: [docs/requirements.md](docs/requirements.md)（v1.1・全章記述済み） / 移行・切り替え: [docs/migration.md](docs/migration.md) / アーキテクチャ: [docs/architecture.md](docs/architecture.md) / データモデル: [docs/data-model.md](docs/data-model.md) / ADR: [docs/adr](docs/adr) / 運用: [docs/operations.md](docs/operations.md) / KPI定義: [docs/kpi-definitions.md](docs/kpi-definitions.md) / API実装規約: [apps/api/CONVENTIONS.md](apps/api/CONVENTIONS.md)

## 構成

```
apps/
  api/     Fastify 5 + zod + Kysely + PostgreSQL 16（モジュラーモノリス / API + ワーカー）
  web/     React 19 + Vite + TanStack Query + Tailwind（スタッフ管理画面 / 顧客向け予約・マイページ）
docs/      要件定義・アーキテクチャ・データモデル・ADR・運用手順・OpenAPI
infra/     docker-compose（PostgreSQL / MinIO / Mailpit）
```

### 主な機能（要件 FR-01〜FR-10）

| 領域 | 内容 |
|---|---|
| 顧客CRM・カルテ | 顧客検索・タグ・メモ（本人のみ閲覧のプライベートメモ）・来店履歴/タイムライン・名寄せ（完全一致/類似ルール）・マージ/取り消し・カルテ（写真/薬剤/スケッチ/テンプレート）・カウンセリングシート/同意書/電子署名・顧客共有リンク |
| 予約管理 | 空き枠計算（営業時間/休業日/シフト/ブロック/バッファ/席・設備）・指名/フリー自動割当・ダブルブッキング三重防止（アドバイザリロック + 重複チェック + EXCLUDE制約）・楽観ロック・状態遷移・Web/LINE/外部/電話/店頭 |
| LINE CRM | 公式アカウント連携（法人/店舗単位）・Webhook署名検証・ID連携・予約確認/変更/取消/リマインド・1対1・セグメント配信・休眠/周期自動配信・オプトアウト |
| POS・決済 | 会計（施術/商品/値引き/クーポン/ポイント/指名料）・税率別端数処理（インボイス対応）・担当者別売上配賦・レジ開局/締め・レシート/領収書・Stripe/モック決済・Webhook・返金・Idempotency |
| 外部予約連携 | アダプタ層・差分/全件同期・競合ポリシー・手動解決キュー・枠ブロック反映・リトライ/DLQ・縮退運転・**ホットペッパービューティー / LiME 連動**（予約通知メールの転送でリアルタイム取り込み、他経路の予約は「媒体の枠止め」依頼として通知、既存予約のCSV取り込み — [ADR 0010](docs/adr/0010-mail-based-booking-media-sync.md)） |
| 口コミ・集客・EC | 口コミ依頼/投稿/返信・Googleビジネスプロフィール連携・スタイリスト公開プロフィール・紹介リンク計測・SNS素材生成・商品/在庫・EC注文/配送 |
| 多店舗・分析・AI | 法人→店舗→スタッフ・RBAC + 店舗/顧客単位の認可・異動時の担当引継ぎ・売上/客単価/新規・再来・失客/リピート率/LTV/メニュー構成/生産性/経路別・離脱予測・売上予測・AI下書き（人の承認必須） |
| データ移行 | 旧システムのCSV（顧客・来店履歴/カルテ・今後の予約）を列の自動対応付け→確認→取り込み。重複防止・家族を混同しない照合・入力済みは上書きしない・ポイント残高/来店回数の引き継ぎ・照合結果・取り消し — [docs/migration.md](docs/migration.md)（切り替え手順つき） |
| 運用 | 監査ログ（追記専用）・障害ダッシュボード・DLQ再実行・Webhook再処理・非同期CSVエクスポート・Feature Flag・保持期間/匿名化 |

## クイックスタート（ローカル）

前提: Node.js 22+, pnpm 10+, PostgreSQL 16（または Docker）

```bash
pnpm install

# 依存サービス（PostgreSQL / MinIO / Mailpit）
docker compose -f infra/docker-compose.yml up -d

# API
cp apps/api/.env.example apps/api/.env
pnpm --filter @salon/api db:migrate
pnpm --filter @salon/api db:seed          # デモデータ（ログイン情報を表示）
pnpm --filter @salon/api dev              # http://localhost:4000  (OpenAPI UI: /docs)
pnpm --filter @salon/api dev:worker       # ジョブワーカー + 定期実行

# Web
pnpm --filter @salon/web dev              # http://localhost:5173
```

- スタッフ管理画面: `http://localhost:5173/app`（デモ: `owner@example.com` / `password-1234`）
- 顧客向け予約: `http://localhost:5173/book/shibuya`（シード店舗）/ EC: `/store/shibuya` / マイページ: `/my`
- 外部サービスは既定でモック（`LINE_DRIVER=mock` など）。LINE ログインは開発時 `mock:<userId>:<表示名>` トークンで動作します。

## 品質状況

| 項目 | 内容 |
|---|---|
| API 統合テスト | 287件（実PostgreSQL・RLS・同時予約・Webhook署名・税計算・名寄せ/マージ・権限境界 など） |
| Web 単体テスト | 58件（税/金額表示・カート・セグメントDSL変換・チャート・日時変換 など） |
| E2E (Playwright) | 12シナリオ（旧システムからの顧客・来店履歴の移行 / ホットペッパー予約メール取込→LiME枠止め依頼 / ゲスト予約 / スタッフ予約作成 / 来店会計 / 店販・分割決済・返金・取消・レジ締め / カルテ・同意書署名・事前問診 / 口コミ依頼〜返信 / EC購入〜発送 / 1対1メッセージ / セグメント作成 / 売上分析） |
| API | 255 エンドポイント（`docs/openapi.json`、起動時は `/docs` で Swagger UI） |
| DB | 88テーブル + マイグレーション23本（RLS・EXCLUDE制約・監査ログ追記専用トリガ） |

## テスト

```bash
# API: 実PostgreSQLを使う統合テスト（TEST_DATABASE_URL のDBを毎回作り直します）
TEST_DATABASE_URL=postgres://salon:salon@localhost:5432/salon_test pnpm --filter @salon/api test
pnpm --filter @salon/api typecheck && pnpm --filter @salon/api lint

# Web
pnpm --filter @salon/web test && pnpm --filter @salon/web build
# E2E: シード済みAPI(:4100)とワーカーを起動した状態で実行（Viteは自動起動）
DATABASE_URL=... pnpm --filter @salon/api db:reset && DATABASE_URL=... pnpm --filter @salon/api db:seed
DATABASE_URL=... PORT=4100 DEV_EXPOSE_OTP=true pnpm --filter @salon/api dev
DATABASE_URL=... pnpm --filter @salon/api dev:worker
pnpm --filter @salon/web test:e2e
```

## 設計の要点

- **マルチテナント**: 全主要テーブルに `organization_id`。PostgreSQL RLS（`FORCE ROW LEVEL SECURITY`）でテナント境界をDBレベルでも強制し、アプリ層の RBAC + 店舗/顧客単位の Resource Authorization と多層化。
- **整合性**: 予約・決済・Webhook は設計初期から Idempotency。予約はロック + アプリ重複チェック + `EXCLUDE USING gist` 制約。
- **非同期処理**: PostgreSQL ベースのジョブキュー（`FOR UPDATE SKIP LOCKED`）+ トランザクショナル・アウトボックス（ドメインイベント→ジョブ）、指数バックオフ、DLQ。
- **外部連携**: Integration Hub のアダプタ層に隔離し、正規化してからドメインへ。raw payload を保存して追跡可能。
- **ファイル**: Object Storage（ローカル / S3 互換 SigV4 署名URL）+ メタデータのみDB。
- **分析**: 集計テーブルをジョブで冪等再構築し、OLTP への重い直接集計を回避。
- **AI**: 提案は `ai_suggestions` に保存し、人の承認なしに外部送信しない。

## デプロイ

**Render へのワンクリック構成**: リポジトリ直下の `render.yaml`（DB・API・ワーカー・Web）。手順は [docs/deploy.md](docs/deploy.md)（ホットペッパー / LiME の受信URLの発行まで）。

`apps/api/Dockerfile` で API とワーカーを同一イメージでビルド（`node dist/index.js` / `node dist/worker.js` / `node dist/db/migrate.js`）。Web は静的ビルドを CDN/nginx で配信。詳細は [docs/operations.md](docs/operations.md)。
