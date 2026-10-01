# Salon OS 運用手順書（Runbook）

- 対象: プラットフォーム運用者（SRE / 開発チーム）、法人管理者（オーナー・店長・`ops.manage` 保有者）
- 関連: [requirements.md](./requirements.md) 10章（セキュリティ）・11章（非機能）・15章（ジョブ）・16章（運用機能）、[architecture.md](./architecture.md) 9章（デプロイ）・11章（観測性）
- 記法: `pnpm --filter @salon/api <script>` は `apps/api` のスクリプト。SQL は運用者ロールで実行する（14章の注意を参照）。

## 1. 運用体制と責任分界

| 役割 | 主な責任 | 使用画面・手段 |
|---|---|---|
| プラットフォーム運用者 | インフラ、デプロイ、マイグレーション、バックアップ/PITR、鍵管理、横断監視、重大インシデント対応 | クラウドコンソール、CI/CD、運用者用 SQL（14章）、監視ダッシュボード |
| 法人管理者（`ops.manage` / `integration.manage` / `audit.read` / `export.data`） | 自法人の DLQ 再実行、Webhook 再処理、外部連携の再同期・競合解決、監査ログ確認、データエクスポート、Feature Flag | 管理画面 O-01〜O-07、S-95 |
| 店舗スタッフ | 同期ステータス確認、配信失敗の再送、レジ差額の確認 | S-55、S-42、S-95 |

## 2. 環境変数

`apps/api/src/config.ts`（zod で検証）と `apps/api/.env.example` を正とする。ローカルは `apps/api/.env`（`NODE_ENV !== 'test'` のとき自動読込）、本番はシークレットマネージャから注入する。

### 2.1 一覧

| 変数 | 既定値 | 本番必須 | 説明 |
|---|---|:-:|---|
| `NODE_ENV` | `development` | ○ | `development` / `test` / `production` |
| `PORT` | `4000` | | API の待受ポート |
| `HOST` | `0.0.0.0` | | 待受アドレス |
| `LOG_LEVEL` | `info` | | pino のログレベル |
| `DATABASE_URL` | `postgres://salon:salon@localhost:5432/salon` | ○ | PostgreSQL 接続文字列（本番はアプリ用ロール） |
| `DATABASE_POOL_MAX` | `20` | | プロセスあたりの最大接続数（台数 × 値 < DB 上限） |
| `API_BASE_URL` | `http://localhost:4000` | ○ | API の公開 URL（署名付き URL・Webhook URL・OpenAPI の servers） |
| `WEB_BASE_URL` | `http://localhost:5173` | ○ | SPA の公開 URL（予約管理リンク・招待リンク等） |
| `CORS_ORIGINS` | `http://localhost:5173` | ○ | 許可オリジン（カンマ区切り） |
| `JWT_SECRET` | `dev-only-…`（32文字以上） | ○ | JWT 署名鍵。本番で `dev-only` 始まりだと起動失敗 |
| `JWT_ACCESS_TTL_SEC` | `900` | | スタッフアクセストークン有効期間（秒） |
| `JWT_REFRESH_TTL_SEC` | `2592000` | | リフレッシュトークン有効期間（30日） |
| `CUSTOMER_JWT_TTL_SEC` | `604800` | | 顧客トークン有効期間（7日） |
| `ENCRYPTION_KEY` | 開発用キー | ○ | 外部資格情報の AES-256-GCM 鍵（32byte の base64、`openssl rand -base64 32`） |
| `TOKEN_SECRET` | `dev-only-…` | ○ | トークン HMAC・署名付き URL・招待の鍵。本番で `dev-only` 始まりだと起動失敗 |
| `STORAGE_DRIVER` | `local` | ○ | `local` / `s3`（本番は `s3`） |
| `STORAGE_LOCAL_DIR` | `./storage` | | local ドライバの保存先 |
| `S3_BUCKET` | — | s3時 | バケット名 |
| `S3_REGION` | — （コード上 `ap-northeast-1` を補完） | s3時 | リージョン |
| `S3_ENDPOINT` | — | | S3 互換エンドポイント（R2 / MinIO 等） |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | — | s3時 | S3 資格情報（`process.env` から直接参照） |
| `LINE_DRIVER` | `mock` | ○ | `mock` / `live` |
| `EMAIL_DRIVER` | `mock` | ○ | `mock` / `smtp` |
| `SMTP_URL` | — | smtp時 | `smtp://user:pass@host:587`（未設定時 `smtp://localhost:1025`） |
| `MAIL_FROM` | — | smtp時 | 送信元（未設定時 `no-reply@salon-os.local`） |
| `SMS_DRIVER` | `mock` | ○ | `mock` / `live` |
| `SMS_GATEWAY_URL` / `SMS_GATEWAY_TOKEN` | — | live時 | SMS HTTP ゲートウェイ |
| `PAYMENT_PROVIDER` | `mock` | ○ | `mock` / `stripe` |
| `STRIPE_SECRET_KEY` | — | stripe時 | Stripe シークレットキー |
| `STRIPE_WEBHOOK_SECRET` | — | stripe時 | Webhook 署名シークレット（`whsec_…`） |
| `ANTHROPIC_API_KEY` | — | | 設定時のみ生成AIを使用（未設定はテンプレート） |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | | 生成に使うモデル |
| `WORKER_CONCURRENCY` | `4` | | Worker の同時実行ジョブ数 |
| `WORKER_POLL_MS` | `1000` | | ジョブが無いときのポーリング間隔 |
| `RATE_LIMIT_MAX` | `300` | | IP あたりの全体レート上限（回/分） |
| `DEV_EXPOSE_OTP` | `false`（`.env.example` は `true`） | ○（false） | OTP をレスポンスに含める（開発/テスト専用）。本番で true だと起動失敗 |
| `TEST_DATABASE_URL` | `postgres://salon:salon@localhost:5432/salon_test` | | テスト用 DB（`vitest.config.ts`、global-setup がスキーマを作り直す） |

### 2.2 本番起動時の安全装置

`config.ts` は `NODE_ENV=production` で次を検出すると起動を中止する: `JWT_SECRET` / `TOKEN_SECRET` が `dev-only` で始まる、`DEV_EXPOSE_OTP=true`。加えてデプロイ前チェックで `ENCRYPTION_KEY` が開発用既定値でないこと、`*_DRIVER` が `mock` でないこと（ステージング除く）を確認する。

## 3. 起動・停止

| 操作 | コマンド | 備考 |
|---|---|---|
| 依存インストール | `pnpm install` | Node 22 以上、pnpm 10 |
| 開発 API | `pnpm --filter @salon/api dev` | `tsx watch src/index.ts`、`/docs` で OpenAPI |
| 開発 Worker | `pnpm --filter @salon/api dev:worker` | ジョブ消費 + 定期スケジューラ |
| ビルド | `pnpm --filter @salon/api build` | `dist/` に出力 |
| 本番 API | `node dist/index.js`（`pnpm start`） | SIGTERM/SIGINT で `app.close()` 後に終了 |
| 本番 Worker | `node dist/worker.js`（`pnpm start:worker`） | SIGTERM で新規取得を止め、実行中ジョブの完了を待って終了 |
| ヘルスチェック | `GET /healthz`（死活）、`GET /readyz`（DB 疎通） | ロードバランサは `/readyz` を使用 |
| テスト | `pnpm --filter @salon/api test` | 実 PostgreSQL（`TEST_DATABASE_URL`） |

## 4. マイグレーション

### 4.1 仕組み

- `src/db/migrate.ts`: `src/db/migrations/*.sql` を名前順に、ファイルごとに1トランザクションで適用し、`schema_migrations(name, checksum)` に記録する。
- 適用済みファイルの内容が変わっているとチェックサム不一致で **失敗** する（既存マイグレーションの編集禁止）。
- `pg_advisory_lock(727274)` で同時実行を防ぐ（複数台から同時に起動しても1つずつ）。
- 適用中は `app.bypass_rls = on`（RLS ポリシー作成・データ移行のため）。

### 4.2 手順

| 環境 | 手順 |
|---|---|
| 開発 | `pnpm --filter @salon/api db:migrate` → `pnpm --filter @salon/api db:codegen`（`src/db/types.ts` 再生成）。`db:reset` は DB を作り直すため、共有 dev DB では使わない |
| ステージング / 本番 | CI/CD のマイグレーション Job で `node dist/db/migrate.js`（マイグレーション用ロールの `DATABASE_URL`）→ 成功後に API → Worker をローリング更新 |

### 4.3 ルール

- 前方互換のみ: 列追加（NULL 可/既定値付き）→ アプリ更新 → 制約強化、の2段階。列削除・改名は参照を外したリリースの後。
- 大きなテーブルへのインデックス追加は `CREATE INDEX CONCURRENTLY` を別マイグレーションで（トランザクション外実行が必要なため、該当ファイルはランナーの対応を確認してから）。
- 失敗時: マイグレーションはファイル単位でロールバックされる。修正版を **新しいファイル** として追加し再実行する（適用済みファイルは編集しない）。データ破損を伴う誤マイグレーションは PITR（6章）で復旧。
- `db:reset` は `NODE_ENV=production` で実行不可。

## 5. Worker 運用

### 5.1 設定

| 項目 | 推奨 |
|---|---|
| 台数 | 2台以上（スケジューラはアドバイザリロックで二重投入しない） |
| 同時実行 | `WORKER_CONCURRENCY` 4〜16。外部 API のレート制限と DB 接続数を考慮 |
| キュー分離 | 一括配信・同期が多い場合は `queue` ごとに専用 Worker（例: messaging 専用）を起動 |
| 停止 | SIGTERM → 実行中ジョブ完了待ち。強制終了された `running` ジョブは10分後に自動で `queued` に戻る（ハンドラは冪等） |

### 5.2 監視クエリ

```sql
-- 状態別件数（法人横断、運用者ロール）
SELECT state, type, count(*) FROM jobs GROUP BY state, type ORDER BY state, count(*) DESC;

-- 滞留: 実行予定時刻を過ぎて待機中のジョブと最古の待ち時間
SELECT queue, count(*), now() - min(run_at) AS oldest_wait
FROM jobs WHERE state = 'queued' AND run_at <= now() GROUP BY queue;

-- 停滞: 10分以上 running（Worker 異常の兆候）
SELECT id, type, locked_by, locked_at, attempts FROM jobs
WHERE state = 'running' AND locked_at < now() - interval '10 minutes';

-- 定期タスクの実行状況（直近）
SELECT dedupe_key, state, created_at, finished_at, last_error FROM jobs
WHERE dedupe_key LIKE 'cron:%' ORDER BY created_at DESC LIMIT 50;
```

アラート目安: 最古待ち > 5分、`dead` が1時間で10件以上増加、停滞ジョブ > 0（architecture.md 11.3）。

## 6. バックアップ・PITR

### 6.1 方針

| 対象 | 方式 | 目標 |
|---|---|---|
| PostgreSQL | マネージド DB の継続的 WAL アーカイブ（PITR）+ 日次スナップショット（35日保持）+ 別リージョン複製 | RPO 5分 / RTO 1時間 |
| Object Storage | バージョニング + 削除保護 + 別リージョン複製（カルテ写真・署名画像） | 誤削除からの復元 |
| 監査ログアーカイブ | 月次でオブジェクトストレージ（Object Lock / WORM）へ | 7年保持 |
| シークレット | シークレットマネージャのバージョン管理 | 鍵の世代管理 |

### 6.2 リストア手順（PITR）

1. 影響範囲と復旧目標時刻（障害発生直前）を決定し、インシデントを宣言（10章）。
2. API・Worker を停止（メンテナンス表示）。Webhook はプロバイダ側で再送されるため、停止中の取りこぼしは再送・再同期で回復する。
3. マネージド DB の PITR で **新しいインスタンス** に目標時刻まで復元。
4. 復元先で整合性確認: `schema_migrations` の最新、主要テーブル件数、直近の `audit_logs` / `domain_events` の時刻。
5. アプリの `DATABASE_URL` を切替え、API → Worker の順に起動。
6. 復旧後処理:
   - `jobs` の `running` は自動回収される。`queued` のまま古いメッセージ配信は、送信済みかどうか `messages.status` / プロバイダ側で確認し、重複リスクがあるキャンペーンは `POST /campaigns/:id/cancel` で止める（LINE は `X-Line-Retry-Key` で24時間内の再送重複を防止）。
   - 失われた時間帯の Webhook: LINE はリトライ、Stripe はダッシュボードから再送（8章）。
   - 外部予約媒体: 全連携アカウントで全件再同期（9章）。
   - Stripe の決済状態: 失われた時間帯の PaymentIntent を突合し、`settleOnlinePayment` を再適用（運用スクリプト）。
7. 四半期ごとにステージングでリストア訓練を行い、所要時間を記録（RTO 1時間以内）。

## 7. DLQ 対応

### 7.1 確認

管理画面 O-02（`GET /ops/jobs?state=dead`）または SQL:

```sql
SELECT id, organization_id, type, attempts, last_error, finished_at, payload
FROM jobs WHERE state = 'dead' ORDER BY finished_at DESC LIMIT 100;
```

### 7.2 判断と対処

| 原因（`last_error`） | 対処 |
|---|---|
| 外部障害（5xx・タイムアウト）が長時間続いた | プロバイダ復旧を確認後、再実行 |
| 資格情報エラー（401/403） | 連携設定（S-56 / S-95）で資格情報を更新し `active` に戻してから再実行 |
| 恒久エラー（400・404、宛先不正、ブロック済み） | 再実行しない。必要ならデータ修正（顧客の連絡先等）後に新しい操作として実行 |
| `No handler registered for job type …` | デプロイ不整合（Worker が古い）。Worker を更新してから再実行 |
| アプリのバグ | 修正をデプロイしてから再実行 |

### 7.3 再実行

- 推奨: 画面 O-02 / `POST /ops/jobs/:id/retry`（監査 `job.retry` が残る）。`state='queued'`, `attempts=0`, `run_at=now()` に戻る。
- 一括（運用者、障害復旧時のみ。実行前に件数を確認し、監査用にチケットへ記録）:

```sql
UPDATE jobs SET state = 'queued', attempts = 0, run_at = now(), last_error = NULL, finished_at = NULL, locked_by = NULL
WHERE state = 'dead' AND type = 'message.deliver' AND finished_at > now() - interval '6 hours';
```

- 不要なジョブ: `POST /ops/jobs/:id/cancel`（`queued` のみ）。`dead` は解決後そのまま保持し、保持期間ジョブで削除しない。

## 8. Webhook 再処理

1. O-03（`GET /ops/webhook-events?status=failed|dead`）で対象を確認。`signature_valid=false` は再処理しない（不正または鍵不一致）。
2. 署名検証が全件失敗している場合: チャネルシークレット / `STRIPE_WEBHOOK_SECRET` の設定誤り・ローテーション漏れを確認（11章）。修正後はプロバイダ側から再送してもらう（保存済みの不正イベントは再検証しない）。
3. 処理失敗（`failed` / `dead`）は原因を修正後 `POST /ops/webhook-events/:id/reprocess`（新しい `webhook.process` ジョブを投入、監査 `webhook.reprocess`）。処理は冪等（イベント ID 単位・終端状態は無視）。
4. 受信できていない場合（ダウンタイム中など）:
   - LINE: Messaging API の Webhook 再送設定を有効にしておく（再送イベントは `deliveryContext.isRedelivery`）。友だち追加等の取りこぼしは顧客の次回ログイン時に `resolveCustomer` で補完される。
   - Stripe: ダッシュボードの Webhook ログから対象イベントを再送。または PaymentIntent 一覧と `payments` を突合。
   - 予約媒体: 全件再同期（9章）。

## 9. 外部予約連携の再同期・縮退復旧

### 9.1 状態確認

S-95 / O-04（`GET /integrations/:id/status`）: `status`、`last_success_at`、`consecutive_failures`、`last_error`、直近の `sync_jobs`。

```sql
SELECT id, organization_id, provider, status, last_success_at, consecutive_failures, last_error
FROM integration_accounts WHERE status IN ('error', 'degraded') ORDER BY last_error_at DESC;
```

### 9.2 手順

| 状況 | 手順 |
|---|---|
| 一時的な取りこぼし | `POST /integrations/:id/sync`（`mode: delta`）→ `sync_jobs` の `stats` を確認 |
| 取込漏れの疑い・マッピング修正後 | `mode: full`（直近60日を再取得、`payload_hash` で変更分のみ反映） |
| `degraded`（連続3回失敗） | 1) プロバイダの障害情報を確認 2) 店舗へ「外部媒体の予約は媒体管理画面で確認、内部台帳へは手入力」の縮退運用を連絡 3) ヘルスチェック（15分毎）が成功すると自動で全件再同期 → `active` 4) 手動で復旧させる場合は資格情報確認後に `mode: full` を実行 |
| `error`（認証エラー） | 資格情報の更新（`POST /integrations/:provider/connect` で再接続）→ `mode: full` |
| 未マッピング（unknown_staff / unknown_menu） | `PATCH /integrations/:id` で `staffMap` / `menuMap` を追加 → 該当の競合を `resolve` → `mode: full` |
| 内部→外部の枠ブロック失敗（push_failed） | 媒体側の枠を手動で確認・ブロック → 競合を `resolve`。原因解消後は `mode: push` |

### 9.3 競合解決

O-04 / `GET /sync-conflicts?state=open` → `POST /sync-conflicts/:id/resolve`:

| resolution | 処理 |
|---|---|
| `keep_internal` | 内部予約を維持し、外部予約は取消依頼（媒体で手動キャンセル）。`external_bookings.sync_state=ignored` |
| `accept_external` | 内部予約を取消（`cancelled_by=external`、顧客へ連絡）し外部予約を取込 |
| `merged` | 同一予約と判断し、外部予約を既存の内部予約に紐付け（`external_bookings.appointment_id`） |
| `manual` | 店舗で個別対応済みとして記録のみ |

いずれも監査 `sync_conflict.resolve` が残る。

## 10. インシデント対応

### 10.1 重大度

| レベル | 例 | 初動目標 |
|---|---|---|
| SEV1 | 全体停止、データ漏えいの疑い、二重課金の多発、RLS 不備の疑い | 15分以内に対応開始、1時間ごとに状況共有 |
| SEV2 | 特定機能停止（予約作成不可、LINE 配信全停止、決済不可）、特定法人の大規模障害 | 30分以内 |
| SEV3 | 一部の連携縮退、DLQ 増加、性能劣化 | 当日中 |

### 10.2 共通フロー

1. **検知・宣言**: アラート / 問い合わせ → インシデントチャンネル作成、指揮者・記録者を決める。
2. **影響範囲の特定**: 対象法人・店舗・期間・機能。`request_id` / `trace_id` でログ・監査・ジョブを横断検索。
3. **封じ込め**: 該当機能の Feature Flag 停止、Worker のキュー停止（配信暴走時）、連携の無効化（`disabled`）、漏えい疑いは関連シークレットの即時ローテーション（11章）とセッション失効。
4. **証跡保全**: 監査ログ・アプリログ・DB スナップショットを保全（上書き・削除しない）。
5. **復旧**: 修正デプロイ、PITR（6章）、DLQ 再実行（7章）、Webhook 再処理（8章）、再同期（9章）。
6. **連絡**: 影響法人への通知（状況・影響・回避策・次回報告時刻）。
7. **法定報告**（個人データの漏えい等）: 報告対象事態（要配慮個人情報、不正利用による財産的被害のおそれ、不正目的、1,000人超）に該当する場合、法人（個人情報取扱事業者）と連携し、個人情報保護委員会へ **速報（把握から概ね3〜5日以内）**・**確報（30日以内、不正目的は60日以内）**、本人への通知を行う。当社が委託先の立場の場合は委託元（法人）へ速やかに報告する。
8. **事後**: 5営業日以内にポストモーテム（タイムライン、原因、再発防止、テスト追加）。

### 10.3 個別プレイブック

| 事象 | 対応 |
|---|---|
| DB 停止・応答遅延 | マネージド DB のフェイルオーバー確認、接続数（`DATABASE_POOL_MAX` × 台数）とロック待ち（`pg_stat_activity`、`pg_locks`）を確認。長時間トランザクションを特定・終了 |
| LINE API 障害 | 配信ジョブは自動再試行。長期化時はトランザクショナル通知をメール/SMS へフォールバック（自動）。マーケティング配信は `POST /campaigns/:id/cancel` で延期 |
| Stripe 障害 | オンライン決済を一時停止（Feature Flag）、店頭はカード端末/現金で継続。復旧後に PaymentIntent と `payments` を突合 |
| 二重予約の報告 | 排他制約により DB 上は発生しない設計のため、まず `appointments` の状態（キャンセル済みとの重なり、別スタッフ、外部媒体側の予約）と `appointment_events` を確認。外部媒体由来なら競合キュー・枠ブロック状態を確認 |
| 誤った顧客統合 | `GET /customers/:id/merge-logs` → `POST /customer-merges/:id/undo`（後続の関連統合があれば逆順に取り消す）。マージ後に作成された記録は手動で付け替え |
| 配信の誤送信・暴走 | 該当キャンペーンを cancel、messaging キューの Worker を停止、未送信 `messages` を `cancelled` に更新、対象顧客へのお詫び配信は承認フローで実施 |
| 漏えいの疑い（不正ログイン等） | 対象ユーザーの全セッション失効（パスワード変更で自動失効、または `auth_sessions` の `revoked_at` 設定）、`audit_logs` で `customer.view` / `export.csv` の異常を確認、必要に応じ鍵ローテーション |
| RLS 不備の疑い | SEV1。該当機能を停止、`information_schema` でポリシー・FORCE の有無を検証（17章のテスト）、影響クエリを特定 |

## 11. 鍵・資格情報のローテーション

| 対象 | 頻度 | 手順 | 影響 |
|---|---|---|---|
| `JWT_SECRET` | 年1回 / 漏えい時即時 | シークレット更新 → API ローリング再起動 | 発行済みアクセストークン（最大15分）が無効化され、クライアントはリフレッシュで再取得（リフレッシュは `TOKEN_SECRET` 依存のため有効） |
| `TOKEN_SECRET` | 漏えい時 | シークレット更新 → API/Worker 再起動 | **リフレッシュトークン・アクセスリンク（予約管理・問診・口コミ等）・OTP・招待・署名付き URL がすべて無効**。スタッフは再ログイン、顧客向けリンクは再発行が必要。定期ローテーションは旧鍵での検証を併用するデュアルキー対応の実装後に行う |
| `ENCRYPTION_KEY` | 年1回 / 漏えい時 | 1) 新鍵を追加（暗号文の版プレフィックス `v2` を割り当てる実装を用意）2) バッチで `integration_accounts.encrypted_credentials`・`line_channels.encrypted_channel_secret` / `encrypted_access_token` を旧鍵で復号 → 新鍵で再暗号化 3) 全件移行を確認後に旧鍵を削除 | 移行中も復号可能（版で鍵を選択）。現行実装は `v1` のみのため、初回ローテーション前に複数鍵対応を実装する |
| LINE チャネルシークレット / アクセストークン | 漏えい時・LINE 側の再発行時 | LINE Developers で再発行 → `PATCH /line-channels/:id` で更新 → `POST /line-channels/:id/verify` | 更新までの Webhook は署名不正（`ignored`）になる。LINE 側の再送で回復 |
| Stripe キー / Webhook シークレット | 漏えい時 | Stripe でロール/再発行 → 環境変数更新 → 再起動。Webhook シークレットはエンドポイントを追加して並行受信 → 旧エンドポイント削除 | 切替中の Webhook は署名不正になり得るため、並行期間を設ける |
| GBP / 予約媒体の資格情報 | プロバイダ規定 | `POST /integrations/:provider/connect` で再接続 | 再接続後に全件再同期 |
| `ANTHROPIC_API_KEY` | 年1回 / 漏えい時 | 更新 → 再起動 | 未設定期間はテンプレートにフォールバック |
| DB パスワード | 年1回 | 新パスワード発行 → シークレット更新 → ローリング再起動 → 旧パスワード無効化 | なし（ローリング） |
| S3 アクセスキー | 年1回（IAM ロール利用を推奨） | 新キー発行 → 更新 → 旧キー無効化 | 署名済み URL は旧キーの有効期間（15分）内は有効 |

## 12. 本人からの開示・訂正・利用停止・削除請求への対応

顧客データの個人情報取扱事業者は各法人（サロン）であり、当社は委託先として法人の対応を支援する。法人管理者が以下の手順で対応し、当社運用者は技術支援・横断作業（ストレージ削除等）を行う。

### 12.1 受付と本人確認

1. 請求の受付（店舗窓口・メール・問い合わせフォーム）。請求種別（開示 / 訂正・追加・削除 / 利用停止・消去 / 第三者提供の停止 / 第三者提供記録の開示）を記録。
2. 本人確認: 登録済みの電話番号/メールへの OTP、または来店時の確認。代理人の場合は委任状。確認できない場合は対応しない。
3. 対象顧客の特定: `GET /customers?q=` で検索し、重複レコード・統合済みレコード（`merged_into_id`）も含めて特定（名寄せ候補 `GET /customers/:id/duplicates`）。
4. 対応期限: 遅滞なく（目安2週間以内）。対応しない場合はその理由を通知。

### 12.2 開示

| データ | 取得元 |
|---|---|
| プロフィール・配信設定・外部ID | `customers`, `customer_channel_preferences`, `customer_identities` |
| 来店・予約履歴 | `appointments`, `appointment_services` |
| カルテ・写真 | `kartes`, `karte_assets`（写真は署名付き URL で提供） |
| 問診・同意書 | `form_responses`（署名画像含む） |
| 会計・ポイント | `transactions`, `transaction_items`, `point_ledger`, `receipts` |
| メッセージ | `messages` |
| 口コミ | `reviews` |
| AI スコア | `customer_scores`（推定値である旨を明記） |
| 第三者提供・委託の記録 | 連携先（LINE、決済代行、予約媒体）と提供項目 |

手順: 顧客詳細・タイムライン（`GET /customers/:id`、`/timeline`、`/visits`）から出力、または運用者が顧客単位のエクスポートを作成（`data_exports` の顧客単位出力は Phase 2 で提供、それまでは運用者スクリプト）。出力は暗号化 ZIP で本人へ交付し、監査ログ（`data_export.request` / `export.csv`）を残す。**プライベートメモ（スタッフ個人の業務メモ）の開示可否は法人の判断**（開示対象となる保有個人データに該当し得るため、原則として開示を検討する）。

### 12.3 訂正・追加・削除（内容の訂正）

`PATCH /customers/:id` 等で訂正（監査 `customer.update`）。署名済み同意書・確定済み会計は改ざん防止のため変更せず、訂正内容を新しい記録（メモ・訂正書）として残す。

### 12.4 利用停止・消去

| 段階 | 処理 |
|---|---|
| 配信停止 | `PUT /customers/:id/channel-preferences`（marketing / transactional を false）、`marketing_opt_in=false`。LINE 連携解除は `DELETE /customers/:id/identities/:identityId` |
| 利用停止 | `PATCH /customers/:id { status: 'blocked' }`（予約受付・配信対象外） |
| 消去（匿名化） | `DELETE /customers/:id`（論理削除、`customer.delete`）→ 30日後に `retention.run` が氏名・連絡先・住所・生年月日・属性・外部IDを匿名化（`status='deleted'`）。即時対応が必要な場合は運用者が匿名化ジョブを個別実行 |
| 保持が必要なデータ | 会計・領収書・決済（税法上7年）、監査ログ（7年）は匿名顧客に紐づけたまま保持し、本人へその旨を説明 |
| ファイル | カルテ写真・署名画像は Object Storage から削除（`files.status='deleted'`、バージョニングの旧版も削除） |
| 外部連携先 | LINE（ブロックは本人操作）、予約媒体・決済代行に保持されるデータは各事業者の手続を案内 |
| 記録 | 監査 `customer.delete` / `retention.anonymize`、請求記録（受付日・本人確認方法・対応内容・完了日） |

### 12.5 法人（契約者）からのデータ返却・解約

解約時は法人管理者が `POST /data-exports`（customers / appointments / transactions / transaction_items / staff_sales）で全データを取得。解約後90日でテナントデータを匿名化・削除し（会計・監査は契約・法令に従い保持）、完了を書面で通知する。

## 13. 定常運用チェックリスト

| 頻度 | 項目 |
|---|---|
| 毎日 | アラート確認、DLQ 件数・内容、Webhook 失敗、縮退中の連携、配信失敗率、夜間ジョブ（analytics / ai / retention / full resync）の成功、バックアップ成功 |
| 毎週 | API p95 と遅いエンドポイント、ジョブ滞留傾向、DB 容量・肥大テーブル（`jobs` / `audit_logs` / `messages` / `webhook_events`）、エラーログ上位、依存パッケージの脆弱性 |
| 毎月 | 監査ログアーカイブ、アクセス権棚卸し（運用者・`ops.manage` 保有者）、コスト（SMS・LINE 通数・ストレージ）、AI 評価指標（14.6） |
| 四半期 | PITR リストア訓練、インシデント対応訓練、鍵ローテーション計画の確認 |
| 年次 | 第三者脆弱性診断、鍵ローテーション（JWT / ENCRYPTION / DB / S3）、保持期間ポリシーの見直し |

## 14. 運用者用 SQL の注意

- 全テナントテーブルは `FORCE ROW LEVEL SECURITY` のため、テーブル所有者ロールで psql 接続しても行は見えない。法人横断の調査は、運用者専用ロールで接続しセッション開始時に `SELECT set_config('app.bypass_rls', 'on', false);` を実行する。特定法人だけを見る場合は `SELECT set_config('app.organization_id', '<orgId>', false);` を使い、バイパスは使わない。
- 運用者による直接 SQL での更新は原則禁止。やむを得ない場合はチケットに SQL・理由・承認者を記録し、`audit_logs` に手動で記録する（`actor_type='system'`, `action='ops.manual_sql'`）。
- `audit_logs` は UPDATE/DELETE できない（トリガ）。本番のアプリ用ロールには `TRUNCATE` / `ALTER TABLE` 権限を与えない。
- 個人情報を含むクエリ結果をチャット・チケットに貼らない（ID のみ共有）。
