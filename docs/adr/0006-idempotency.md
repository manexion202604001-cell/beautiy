# ADR 0006: 冪等性を全層で設計初期から実装する

- 状態: 承認（Accepted）
- 日付: 2026-10-01
- 関連: requirements.md 8.1.1 / FR-05 / 21、`plugins/idempotency.ts`、`payments/api.ts`、`messaging/api.ts`、`jobs/queue.ts`

## Context（背景）

- 要件 21「予約・決済・Webhook は Idempotency を設計初期から実装」、FR-05「二重課金防止・Idempotency Key」。
- モバイル回線・LINE 内ブラウザでは再送（タイムアウト後のリトライ、二度押し）が頻繁に起きる。
- 外部プロバイダの Webhook は at-least-once で、同じイベントが複数回届く。
- ジョブキューは at-least-once 実行（停滞回収・再試行、ADR 0004）。
- 公開予約 API はテナント未確定のまま受け付ける（ログインなしのゲスト予約）。

## Decision（決定）

| 層 | 仕組み | 詳細 |
|---|---|---|
| API（認証済み） | `Idempotency-Key` ヘッダ（ルート設定 `config.idempotent` に `true` または `'required'`） | `idempotency_keys(organization_id, scope, key)` 一意。scope = `<METHOD> <route>:<actorId>`、`request_hash = sha256(body + params)`、24時間保持。新規 → `in_progress` で実行し、5xx 以外のレスポンスを保存 → 再送は保存レスポンスを `idempotent-replayed: true` で返す。同じキーで別内容 → 422 `IDEMPOTENCY_KEY_REUSED`、処理中の重複 → 409 `IDEMPOTENCY_IN_PROGRESS`、5xx → 記録削除（安全に再試行可） |
| API（公開・テナント未確定） | `clientRequestId`（ボディ） | 同一店舗・24時間内に同じ `clientRequestId` の予約があれば既存予約を 200 + `replayed: true` で返す（`appointments.source_detail.clientRequestId`） |
| 決済 | `payments(organization_id, idempotency_key)` 一意 + プロバイダへ同じキー | `startOnlinePayment()` は既存行があれば金額・対象の一致を確認して既存結果を返す（不一致は `IDEMPOTENCY_KEY_REUSED`）。Stripe の HTTP `Idempotency-Key` にも同じ値。返金は `refunds(organization_id, idempotency_key)` |
| 決済状態 | 終端状態の再遷移を無視 | `settleOnlinePayment()` は成功/失敗/取消/返金済みなら何もしない |
| Webhook | `webhook_events(provider, event_id)` 一意 | event id はプロバイダのイベント ID（無ければ raw body の sha256）。重複は保存せず 200 |
| ジョブ | `jobs.dedupe_key`（queued/running の間一意） | 例: `message:<id>`、`review_request:<transactionId>`、`analytics:<shopId>:<date>`、定期 `cron:<name>:<bucket>` |
| メッセージ | `messages(organization_id, dedupe_key)` 一意、LINE `X-Line-Retry-Key` | キャンペーン `campaign:<id>:<customerId>`、リマインド `reminder:<kind>:<appointmentId>:<startAt>`。自動配信は `automation_runs(automation_id, dedupe_key)` |
| 業務一意性 | 部分一意インデックス | 予約の有効会計は1件、会計1件の口コミ依頼は1件、外部予約 ID は1件 |

重要書き込み（予約作成/変更/状態遷移、顧客作成・マージ、会計確定・返金、決済開始、配信送信、エクスポート依頼）は `idempotent` を宣言し、会計確定・返金・決済開始は `'required'` とする。

## Consequences（結果）

**良い点**
- 再送・二度押し・Webhook 重複・ジョブ再実行のいずれでも、予約・課金・送信が二重にならない。
- クライアントは 5xx / タイムアウト時に同じキーで安全に再試行できる。

**悪い点・リスク**
- 冪等キー記録のための追加 DB 書き込み（1リクエストあたり2回の短いトランザクション）。
- 冪等プラグインは業務トランザクションとは別トランザクションで記録・完了するため、業務コミット後・レスポンス保存前にプロセスが落ちると `in_progress` が残る（24時間後に失効し再利用可。クライアントには 409 が返る）。
- キーのスコープは Actor 単位のため、別スタッフが同じキーを使っても別リクエストとして扱われる（意図どおり）。
- 公開予約の `clientRequestId` は任意項目のため、SPA で必ず生成して送る必要がある。

## Alternatives（検討した代替案）

| 案 | 不採用理由 |
|---|---|
| 業務の一意制約だけで重複を防ぐ | 「同じ操作の再送」と「正当な2回目の操作」を区別できない（例: 同じ顧客の2件目の予約） |
| 冪等キーを業務トランザクション内で記録 | 最も厳密だが全サービスに横断的な実装が必要。プラグイン方式で全ルートに一律適用し、決済・配信は業務テーブル側の一意制約で二重に守る |
| クライアント側の二度押し防止のみ | ネットワーク再送・Webhook 重複には無力 |
