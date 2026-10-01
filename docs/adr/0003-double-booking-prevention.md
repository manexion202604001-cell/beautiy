# ADR 0003: 3層の二重予約防止（アドバイザリロック + overlap 判定 + EXCLUDE 制約）

- 状態: 承認（Accepted）
- 日付: 2026-10-01
- 関連: requirements.md FR-02 / 12章、`modules/appointments/service.ts`（`resolvePlan`）、`availability.ts`、`0005_appointments.sql`

## Context（背景）

- 予約は Web / LINE / 外部媒体 / 電話 / 店頭 / スタッフ操作から同時に入る。同じスタッフ・同じ設備の同じ時間への並行予約を確実に1件にしなければならない（FR-02「ダブルブッキング防止・競合時トランザクション制御」）。
- 要件 12 は「DB の一意制約/排他制御だけに依存せず、業務時間帯の overlap チェックを実装」と定める。利用者に「なぜ予約できないか」（営業時間外・設備不足・受付締切など）を伝える必要もある。
- 施術時間の前後にバッファ（準備・片付け）があり、席・シャンプー台など容量1の設備をメニューの一部時間だけ使う。
- フリー予約は空いているスタッフから自動で割り当てる。

## Decision（決定）

**第1層: アドバイザリロックで直列化**
- 予約作成/変更時、候補スタッフ ID を昇順に `pg_advisory_xact_lock(hashtextextended('staff:<id>', 0))` で取得し、選ばれた設備も同様に `resource:<id>` で取得する。トランザクション終了で自動解放。安定順序でデッドロックを避ける。

**第2層: 業務ルールでの overlap 判定**
- `checkSlot()` が、営業時間・休業日・シフト（日付指定が週パターンを置換）・予約ブロック・既存予約の **占有時間**（バッファ込み）・必要設備の空き・リードタイム・受付期間を評価し、理由コード（`outside_schedule` / `staff_busy` / `resource_unavailable` / `lead_time` / `horizon`）を返す。失敗は 409 `SLOT_UNAVAILABLE`。
- フリー予約は可能な候補のうち当日予約分数が最少のスタッフを選ぶ（`chooseLeastBusyStaff`）。
- スタッフ上書き `allowOutsideSchedule` は営業時間外のみ許可し、重複は許可しない。

**第3層: DB 排他制約（最終防御）**
- `appointments_no_staff_overlap EXCLUDE USING gist (staff_id WITH =, tstzrange(occupied_start_at, occupied_end_at, '[)') WITH &&) WHERE (staff_id IS NOT NULL AND deleted_at IS NULL AND status IN ('tentative','confirmed','checked_in','in_service','completed'))`
- `appointment_resources_no_overlap EXCLUDE USING gist (resource_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&) WHERE (is_active)`
- 違反（SQLSTATE 23P01）は `fromPgError()` で 409 `APPOINTMENT_OVERLAP` / `RESOURCE_OVERLAP` に変換する。

**付随ルール**
- 占有時間 = 開始 − 先頭メニュー前バッファ 〜 終了 + 末尾メニュー後バッファ（`CHECK (occupied_start_at <= start_at AND occupied_end_at >= end_at)`）。
- キャンセル/無断キャンセルで枠を解放（排他制約の対象外状態、`appointment_resources.is_active = false`）。復元時は制約で再検証される。
- 変更は楽観ロック（`version`）と `FOR UPDATE`。履歴は `appointment_events`。
- 外部媒体からの予約も同じ `createAppointment(..., { trusted: true })` を通し、同じ3層で守る。

## Consequences（結果）

**良い点**
- 並行リクエストでも成立は1件（統合テスト「prevents double booking sequentially and under concurrency」で検証）。アプリのバグや新しい経路（外部同期・管理ツール）があっても DB が重複を拒否する。
- 利用者には業務的な理由が返り、UI で代替枠を提示できる。
- アドバイザリロックにより、排他制約違反で失敗するより前に待機→再判定となり、ユーザー体験が安定する。

**悪い点・リスク**
- 予約ブロック（`schedule_blocks`）は排他制約の対象ではなく、第2層でのみ守られる（ブロック作成と予約作成が同時に起きた場合の厳密性は第1層のロック順序に依存）。
- フリー予約は候補スタッフ全員をロックするため、大人数店舗で同時刻のフリー予約が集中すると待ちが増える（NFR-P02 の負荷試験で確認）。
- `hashtextextended` のハッシュ衝突で無関係なスタッフ同士が直列化される可能性がある（正しさには影響しない）。

## Alternatives（検討した代替案）

| 案 | 不採用理由 |
|---|---|
| アプリの overlap 判定のみ | 並行トランザクションで両方が「空き」と判定し得る（read committed） |
| 排他制約のみ | 正しさは担保できるが、業務理由（営業時間外・設備不足）を返せず、要件 12 に反する |
| SERIALIZABLE 分離レベル | 予約以外の更新も含むトランザクションで再試行が頻発し、外部同期・会計と組み合わせると扱いにくい |
| 時間枠テーブル（15分スロット行）の一意制約 | スロット粒度に縛られ、可変所要時間・バッファ・設備の部分利用を表現しにくい。データ量も増える |
| 予約ごとの `SELECT … FOR UPDATE`（スタッフ行ロック） | スタッフ行の更新と競合しやすく、設備ロックとの順序管理が複雑。アドバイザリロックの方が意図が明確 |
