# ADR 0004: PostgreSQL ジョブキューとトランザクショナル・アウトボックス

- 状態: 承認（Accepted）
- 日付: 2026-10-01
- 関連: requirements.md 15章、architecture.md 5章、`jobs/queue.ts`、`jobs/scheduler.ts`、`lib/events.ts`

## Context（背景）

- 予約確定通知・リマインド・口コミ依頼・外部同期・Webhook 処理・集計・エクスポートなど、多数の非同期処理がある。
- 「予約は確定したが通知ジョブが消えた」「ロールバックしたのに通知が飛んだ」を防ぐ必要がある（業務変更とジョブ投入の原子性）。
- 外部サービス障害時は指数バックオフで再試行し、上限超過は DLQ に送り、運用者が再実行できること（要件 9.1 / 16）。
- 定期処理（5分毎の差分同期、夜間集計）を複数 Worker 環境で1回だけ実行したい。
- インフラ構成を最小化したい（ADR 0001）。

## Decision（決定）

1. ジョブは PostgreSQL の `jobs` テーブルに保存し、Worker が `SELECT … FOR UPDATE SKIP LOCKED` で取得する（`claim`）。
2. `enqueue()` は呼び出し元の **業務トランザクション内** で INSERT する。業務がコミットされたときだけジョブが存在する（トランザクショナル・アウトボックス）。
3. ドメインイベント `emit()` は `domain_events` に永続化し、同一トランザクション内で購読者（`onEvent`）を同期実行する。購読者は原則ジョブ投入だけを行う。
4. 再試行は `min(5秒 × 2^(attempt−1), 1時間) × (0.8〜1.2)`、既定 `max_attempts = 8`。`RetryLaterError(delayMs)` は指定遅延、`PermanentJobError` は即 `dead`。`dead` が DLQ。
5. `dedupe_key` は `queued` / `running` の間一意（部分一意インデックス）。リマインド等の重複投入を防ぎ、`cancelJobs(prefix)` で取り消せる。
6. Worker は60秒毎に10分以上 `running` のジョブを `queued` に戻す（クラッシュ回復）。そのため **ハンドラは冪等** に実装する。
7. 定期タスクは `registerPeriodic({ name, jobType, bucket })`。Worker が30秒毎に `schedulerTick()` を実行し、アドバイザリロック下で `cron:<name>:<bucket>` のジョブを各期間1回だけ投入する。定期ジョブはグローバル（`organization_id = NULL`）で起動し、法人ごとに fan-out する。

## Consequences（結果）

**良い点**
- 追加インフラ（Redis / SQS / Kafka）が不要で、ジョブ・業務データ・監査が同じバックアップ・PITR で保護される。
- 原子性: ロールバックで通知も消え、コミットで必ずジョブが残る。外部ブローカー利用時に必要な二相コミットやアウトボックスのリレーが不要。
- SQL でジョブの状態・DLQ を検索・集計でき、ops 画面（DLQ 再実行）を容易に作れる。`trace_id` でリクエストからジョブまで追跡できる。

**悪い点・リスク**
- スループット上限は DB に依存（数百〜数千ジョブ/秒程度が目安）。一括配信などの大量ジョブは `queue` 分離・バッチ化で対処し、限界に達したら配信だけ専用ブローカーへ移す（architecture.md 10章）。
- `jobs` テーブルの肥大化 → 成功ジョブを14日でパージ（`retention.run`）、将来はパーティション化。
- at-least-once 実行（停滞回収・再試行）であり、外部への二重送信を防ぐには冪等キー（LINE `X-Line-Retry-Key`、Stripe `Idempotency-Key`、`messages.dedupe_key`）が必須。
- イベント購読者が同期実行のため、購読者の重い処理や例外は発行元トランザクションを失敗させる → 購読者はジョブ投入のみ、という規約で守る。

## Alternatives（検討した代替案）

| 案 | 不採用理由 |
|---|---|
| Redis + BullMQ 等 | 業務トランザクションとの原子性がなく、アウトボックスの別実装が必要。運用対象が増える |
| SQS / Pub/Sub | 同上。ローカル開発・テストの再現性が下がる |
| pg-boss 等のライブラリ | 機能は近いが、依存を増やさない方針（API に npm 依存を追加しない）と、テナント RLS・`trace_id`・dedupe の独自要件に合わせるため自前実装 |
| LISTEN/NOTIFY のみ | 永続性・再試行・DLQ がない。将来、ポーリング間隔短縮の補助として併用は可能 |
