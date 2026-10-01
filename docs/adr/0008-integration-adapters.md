# ADR 0008: 外部連携は Adapter 層に隔離し、Integration Hub で正規化・追跡する

- 状態: 承認（Accepted）
- 日付: 2026-10-01
- 関連: requirements.md 9章 / FR-03 / FR-05 / FR-06 / FR-07、architecture.md 6章、`lib/webhooks.ts`、`lib/storage.ts`、`lib/mailer.ts`、`lib/line-auth.ts`

## Context（背景）

- 連携先は LINE（Messaging API / LINE Login）、Stripe（決済）、Google Business Profile（口コミ）、予約媒体、Object Storage、メール/SMS、生成AI と多岐にわたり、将来も増える（Square、追加の予約媒体）。
- 要件 21「外部連携は Adapter 層に隔離し、プロバイダ固有仕様をドメインへ漏らさない」、要件 9.1「内部共通モデルへ Normalize」「外部固有 ID・状態・raw payload を保存」「Retry は指数バックオフ、上限超過は DLQ」「再同期画面」。
- 0.2 非目的: 特定外部予約媒体の非公開 API への依存。最初の予約媒体は契約未確定（23.1）。
- 開発・テスト・デモを外部アカウントなしで行いたい。

## Decision（決定）

1. **Adapter インタフェース** をドメインごとに定義し、プロバイダ実装は `modules/<module>/providers/<provider>.ts`（横断的なものは `lib/`）に置く。
   - 予約媒体: `connect` / `healthCheck` / `fetchChanges(cursor)` / `fetchRange(from, to)` / `blockSlot` / `releaseSlot`（任意 `cancelBooking`）→ NormalizedBooking
   - 決済: `createIntent` / `refund` / `cancel` / Webhook 解釈 → PaymentResult（`payments/api.ts` の公開契約の内側）
   - 配信: チャネル別 `send`（LINE push / SMTP / SMS ゲートウェイ）
   - 口コミ: `listReviews(since)` / `reply(externalId, body)` → NormalizedReview
   - ストレージ: `StorageDriver`（local / s3）
   - 生成AI: `AiProvider.generate`（heuristic / anthropic）
2. **すべてのプロバイダに mock 実装** を持たせ、環境変数（`LINE_DRIVER`, `EMAIL_DRIVER`, `SMS_DRIVER`, `PAYMENT_PROVIDER`, `STORAGE_DRIVER`）や `integration_accounts.provider = 'mock_booking'` で切り替える。テストは mock で完結する。
3. **受信は汎用 Webhook パイプライン**: `POST /v1/webhooks/:provider` → `registerWebhookProvider(name, { verify, process })` の `verify`（署名検証・event id 抽出、不正でも throw しない）→ `webhook_events` に保存（`(provider, event_id)` 一意）→ 即時 200 → `webhook.process` ジョブで `process(ctx, event)`。
4. **送信・同期はジョブ内** で行い、業務トランザクション内で外部 HTTP を呼ばない（対話的な例外を除く）。タイムアウト 10秒。エラーを「再試行 / `RetryLaterError`（429・Retry-After）/ `PermanentJobError`（恒久エラー）」に分類する。
5. **追跡性**: 外部 ID・外部状態・raw payload・正規化結果・`payload_hash` を保存（`external_bookings`、`payments.provider_payment_id`、`reviews.external_review_id`、`messages.provider_message_id`）。同期履歴は `sync_jobs`、競合は `sync_conflicts`。
6. **資格情報** は AES-256-GCM で暗号化して保存（`integration_accounts.encrypted_credentials`、`line_channels.encrypted_*`）し、応答・ログ・監査に出さない。
7. **縮退運転**: 予約媒体は連続3回失敗で `degraded`（自動同期停止、通知、ヘルスチェック成功で全件再同期して復帰）。
8. **公式 API のみ** を使用し、非公開 API・スクレイピングは使わない。

## Consequences（結果）

**良い点**
- プロバイダの追加・変更が Adapter 1ファイル + マッピングで済み、ドメインロジック（予約作成・決済確定・名寄せ）は不変。
- 外部障害が業務トランザクションに波及しない（受信は保存のみ、送信はジョブ）。DLQ・再処理・再同期で運用回復できる。
- raw payload 保存により、障害調査・再正規化（マッピング修正後の再処理）が可能。

**悪い点・リスク**
- 共通モデルに収まらないプロバイダ固有機能（媒体独自のクーポン等）は `raw_payload` / `normalized` の拡張項目で扱う必要がある。
- 非同期化により、外部反映に数秒〜数分の遅延が生じる（NFR-P07、差分同期5分）。
- 依存ライブラリを使わず自前実装するため（S3 SigV4、Stripe 署名検証等）、仕様準拠を契約テスト（既知ベクタ・記録済みフィクスチャ）で担保する必要がある。

## Alternatives（検討した代替案）

| 案 | 不採用理由 |
|---|---|
| 各モジュールがプロバイダ SDK を直接呼ぶ | 固有仕様がドメインに漏れ、プロバイダ変更・テストが困難。依存追加方針にも反する |
| Webhook を受信リクエスト内で同期処理 | 処理遅延でプロバイダがタイムアウト・再送し、重複処理や取りこぼしが起きる |
| iPaaS / 外部連携基盤の利用 | テナント別資格情報・RLS・監査との統合が難しく、コストと依存が増える |
| 予約媒体の画面スクレイピング | 非目的（0.2）・規約違反のリスク |
