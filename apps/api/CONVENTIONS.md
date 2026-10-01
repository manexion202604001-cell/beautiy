# API 実装規約 (apps/api)

モジュラーモノリス。各ドメインは `src/modules/<name>/` に閉じ、他モジュールとは **サービス関数・公開契約 (`api.ts`)・ドメインイベント** でのみ連携する。

## 1. ディレクトリ

```
src/
  config.ts              環境変数 (zod)
  server.ts / index.ts   Fastify 構築 / 起動
  worker.ts              ジョブワーカー + 定期スケジューラ
  db/
    migrations/*.sql     前方専用SQLマイグレーション (番号順)
    types.ts             kysely-codegen 生成物 (手編集禁止)
    tenant.ts            withTenant / withSystem (RLS コンテキスト)
  auth/                  actor / permissions / jwt
  lib/                   横断ライブラリ (errors, audit, events, money, time, csv, storage, crypto, access-tokens, webhooks ...)
  jobs/                  queue.ts (Postgres SKIP LOCKED) / scheduler.ts
  modules/<name>/
    index.ts             Fastify プラグイン (ルート定義) + 副作用登録 (jobs/events/seeders) の import
    service.ts           ドメインロジック (Ctx を受け取る)
    schemas.ts           zod スキーマ
    api.ts               (任意) 他モジュール向け公開契約
    *.test.ts            統合テスト (実DB)
```

## 2. Ctx パターン

全サービス関数の第1引数は `ctx: Ctx` (`{ actor, trx, meta }`)。

- ルート: `(req) => req.tx((ctx) => svc.fn(ctx, req.body))` — テナント RLS 付きトランザクション。
- ジョブ: `jc.tx((ctx) => ...)` — system actor。
- 公開API: `publicTx(shop, req.meta, fn)` (modules/public/service.ts)。

`ctx.trx` は Kysely Transaction。**1リクエスト=1トランザクション** が原則。

## 3. 認可 (必須)

- サービス冒頭で `requirePermission(ctx.actor, 'xxx.yyy')`。権限キーは `auth/permissions.ts` に定義済み (追加する場合は同ファイルに追記し、SYSTEM_ROLES への割当も検討)。
- 店舗境界: `assertShopAccess(ctx.actor, shopId)`。一覧は `accessibleShopIds(ctx.actor)` で絞る (null=制限なし)。
- 顧客境界: `assertCustomerAccess(ctx, customerId)` (modules/customers/access.ts)。存在を漏らさないため不可視は 404。
- system actor は全権限 (`can()` が true)。customer actor は permission を持たない → 顧客向け処理は専用関数で本人確認。
- RLS により他テナントの行は物理的に見えない (多層防御)。`withSystem` (RLSバイパス) はテナント解決・Webhook・ジョブ取得などに限定。

## 4. 監査・イベント・ジョブ

- 重要更新・閲覧・CSV出力・権限変更は `audit(ctx, { action, resourceType, resourceId, before, after })` を **同一トランザクション内** で記録。更新差分は `diff(before, after)`。
- ドメインイベント: `emit(ctx, { type, aggregateType, aggregateId, payload })` → `domain_events` に永続化し、`onEvent(type, handler)` の購読者が同一トランザクションで実行される (購読者は主にジョブ投入のみ行う = トランザクショナル・アウトボックス)。
- ジョブ: `registerJob(type, handler)` / `enqueue(ctx, { type, payload, runAt, dedupeKey })`。失敗は指数バックオフ、`max_attempts` 超過で `dead` (DLQ)。`RetryLaterError` / `PermanentJobError` を使い分ける。
- 定期実行: `registerPeriodic({ name, jobType, bucket: everyMinutes(5) | dailyAt(3) })`。ハンドラはグローバル (organization_id NULL) で起動されるので、組織ごとに fan-out する (`withSystem` で組織一覧 → `enqueue(trx, { organizationId })`)。
- 新規法人の初期データ: `registerOrgSeeder(name, fn, order)`。
- 副作用登録は各モジュール `index.ts` から import されること (server と worker の両方が `modules/index.ts` を読む)。

### イベントカタログ (現行)

| type | payload | 発行元 |
|---|---|---|
| organization.created | { shopId } | org |
| shop.created | {} | org |
| staff.created / staff.transferred | { shopIds } / transfer input | org |
| customer.created / updated / deleted | { shopId? } | customers |
| customer.merged / merge_undone | { sourceId, targetId, mergeLogId } | customers |
| appointment.created | { shopId, customerId, staffId, startAt, source, status } | appointments |
| appointment.rescheduled / updated | { shopId, customerId, staffId, startAt, previousStartAt, previousStaffId } | appointments |
| appointment.confirmed / checked_in / in_service / completed / cancelled / no_show / restored | { shopId, customerId, staffId, startAt, from, to, reason, cancelledBy } | appointments |
| payment.succeeded / failed / refunded | { paymentId, transactionId, orderId, amount, refundedAmount? } | payments |
| transaction.completed / voided / refunded | { transactionId, shopId, customerId, appointmentId, total, completedAt } | pos |
| message.sent / message.failed | { messageId, customerId, channel } | messaging |
| karte.created / karte.shared | { karteId, customerId, shopId } | kartes |
| review.submitted | { reviewId, shopId, staffId, rating } (内部口コミ投稿時のみ。Google取込では発行しない) | reviews |
| order.paid | { orderId, customerId, total, shopId, referralLinkId, attributedStaffId } | commerce |
| order.shipped | { orderId, customerId, total, carrier, trackingNumber } | commerce |
| order.cancelled | { orderId, customerId, total, refundedAmount, reason } | commerce |
| integration.degraded / integration.recovered | { integrationAccountId, provider } | integrations, reviews (Google Business Profile) |

新しいイベントを追加したら本表に追記すること。

## 5. 公開契約

- メッセージ送信は必ず `modules/messaging/api.ts` の `queueMessage()` / `cancelQueuedMessages()`。
- オンライン決済・返金は `modules/payments/api.ts` の `startOnlinePayment()` / `settleOnlinePayment()` / `refundPayment()`。
- 予約の作成/変更/状態遷移は `modules/appointments/service.ts` の `createAppointment` / `updateAppointment` / `transitionAppointment` (外部・公開チャネルは `{ trusted: true }`)。
- 顧客の名寄せは `modules/customers/identity.ts` の `resolveCustomer()`、統計再計算は `customers/stats.ts` の `recomputeCustomerStats()`。
- Webhook は `lib/webhooks.ts` の `registerWebhookProvider(name, { verify, process })`。ルート `/v1/webhooks/:provider` は integrations モジュールが提供。
- 署名付き一時リンクは `lib/access-tokens.ts`。ファイルは `lib/storage.ts` (DBにはメタデータのみ)。

## 6. API 規約 (要件 8.1)

- パスは `/v1/...` (プラグインは prefix '/v1' 配下で絶対パスを書く: `app.get('/customers', ...)`)。
- 入力は zod (`schema: { body, querystring, params }`)。**PATCH 用スキーマに `.default()` を置かない** (既存値を上書きする事故になる)。デフォルトは作成用スキーマだけに。
- 一覧は cursor pagination (`lib/pagination.ts`) — `{ items, nextCursor }`。
- 重要な書き込みは `config: { idempotent: true }` (Idempotency-Key)。
- 公開ルートは `config: { auth: 'public' }`、顧客ルートは `config: { auth: 'customer' }`。既定は staff。
- 日時は UTC 保存 (`timestamptz`)、表示・日付境界は店舗 TZ (`lib/time.ts`)。
- エラーは `Errors.*` (`lib/errors.ts`) を throw。カテゴリ: validation / business / authentication / authorization / not_found / conflict / external / rate_limit / system。メッセージは日本語。
- 金額は整数円。税は `lib/money.ts` (内税・税率別端数処理・`allocate()` で按分)。
- 作成/更新時は `created_by` / `updated_by` (`auditUserId(ctx.actor)`) と `trace_id` (`ctx.meta.traceId`) を設定。

## 7. DB / マイグレーション

- 既存マイグレーションは編集しない。追加は新ファイル。モジュール別番号帯: pos/payments 0100-0109, messaging 0110-0119, kartes/files 0120-0129, integrations/ops 0130-0139, reviews/marketing/commerce 0140-0149, analytics/ai 0150-0159。
- 追加テーブルに `organization_id` を持たせる場合、RLS ポリシーをそのマイグレーション内で作成する (0090 と同じ形式)。
- 適用: `pnpm db:migrate` (dev DB) → 型生成: `pnpm db:codegen`。`db:reset` は共有 dev DB を消すので並行作業中は使わない。

## 8. テスト

- Vitest + 実 PostgreSQL。`TEST_DATABASE_URL` で DB を指定 (global-setup がスキーマを作り直す)。
- ヘルパー: `src/test/helpers.ts` (`createTenant`, `createStaffUser`, `createMenu`, `createCustomer`, `api(token)`, `asSystem`, `runJobs`, `nextWeekday`, `jst`)。
- テストごとに新しいテナントを作るので相互干渉しない。
- 外部サービスは mock ドライバ (LINE_DRIVER / EMAIL_DRIVER / SMS_DRIVER / PAYMENT_PROVIDER = mock)。

## 9. 依存関係

API に npm 依存を追加しない (HTTP は `fetch`、暗号は `node:crypto`)。
