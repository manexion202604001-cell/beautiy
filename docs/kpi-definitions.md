# KPI定義書（分析・LTV / AI拡張）

対象: `apps/api/src/modules/analytics`・`apps/api/src/modules/ai`（要件 FR-10 / 13.2 / 14 / 21）
金額はすべて **税込・整数円**。率（%）は小数第1位で四捨五入、分母が0のときは `null`。

---

## 1. 前提

### 1.1 データの流れ

| 層 | 内容 |
|---|---|
| 元データ（OLTP） | `transactions` / `transaction_items` / `transaction_item_staff` / `appointments` / シフト類 |
| 日次集計テーブル | `analytics_daily_shop` / `analytics_daily_staff` / `analytics_daily_menu` / `analytics_daily_source`（店舗×店舗ローカル日付） |
| 集計ジョブ | `analytics.rebuild_day {shopId, date}` が1店舗・1日分を元データから再計算し、同一トランザクション内で **DELETE → INSERT**（冪等） |

要件21「分析は本番OLTPへの重い直接集計を避ける」に従い、**売上・件数系レポートはすべて日次集計テーブルから** 読みます。
顧客単位の指標（新規/再来/失客・来店周期・リピート率・LTV）は日次集計では表現できないため、
「来店としてカウントされる会計」だけを部分インデックス `transactions_counted_customer_idx` で読むライブ集計です。

### 1.2 再集計のタイミング

| トリガー | 動作 |
|---|---|
| `transaction.completed` / `voided` / `refunded` | 会計日（`completedAt` の店舗ローカル日付）を再集計 |
| `appointment.created` / `rescheduled` / `updated` / 各ステータス遷移 | 予約日（`startAt`、変更時は `previousStartAt` も）を再集計 |
| デバウンス | ジョブは `dedupeKey = analytics:<shopId>:<date>`・**30秒後** 実行。同じ日のイベントが連続しても1回に集約。実行中に新しい変更が来た場合は `…:followup` ジョブを1つだけ追加 |
| 夜間（毎日 2:00 JST） | `analytics.nightly_rebuild` → 法人ごとに `analytics.rebuild_org_recent` → 各店舗の **前日〜3日前** を再集計（遅れて入った返金・修正の取り込み） |
| 手動 | `POST /v1/analytics/rebuild {shopId, from, to}`（`ops.manage`、最大400日、監査 `analytics.rebuild`） |

### 1.3 タイムゾーン

- DBは UTC（`timestamptz`）。日付境界は **店舗のタイムゾーン**（`shops.timezone`、既定 Asia/Tokyo）。
- 会計は `completed_at`、予約は `start_at` の店舗ローカル日付に計上。
- API の `from` / `to` は店舗ローカル日付（両端を含む）。省略時は「当月1日〜今日」。
- 複数店舗をまとめた顧客単位指標は、店舗のTZが全て同じならそのTZ、異なる場合は法人TZ（`organizations.timezone`）で日付境界を切ります。

### 1.4 会計ステータスの扱い

| status | 売上（純額） | 会計件数・来店 | 備考 |
|---|---|---|---|
| `completed` | `total` | ○ | |
| `partially_refunded` | `total − refunded_total` | ○ | |
| `refunded`（全額返金） | `total − refunded_total`（通常0） | × | 来店にも会計件数にも数えない |
| `voided`（取消） | 計上しない | × | |
| `draft` | 計上しない | × | |

**返金は元の会計日の売上から控除**します（返金日ではなく売上計上日基準）。返金額そのものは `refund_total` に記録。

### 1.5 按分ルール

1. **会計内の按分**: 会計の純額（`total − refunded_total`）を、金額が正の明細（`service` / `nomination_fee` / `product` / `adjustment`）へ **明細金額比で按分**（最大剰余法 `allocate()`、合計は必ず一致）。
   値引・クーポン行（負の明細）や返金は、この按分により施術・店販へ比例配分されます。
2. **施術/店販の区分**: `product` 明細 → 店販売上、それ以外（施術・指名料・調整）→ 施術売上。明細の無い会計は施術売上。
   したがって常に `施術売上 + 店販売上 = 純売上`。
3. **スタッフ按分**: 明細の按分後金額を `transaction_item_staff.share_bp` の比で各スタッフへ配分（share がすべて0なら `allocated_amount` 比、それも0なら均等）。
   役割（main / assistant / referral）を問わず売上は配分。担当者の無い明細の売上はどのスタッフにも計上されません（店舗合計には含む）。
4. **消費税**: `tax_total − floor(tax_total × refunded_total ÷ total)`（返金分を按分控除）。

---

## 2. 売上KPI（`GET /v1/analytics/sales`）

| KPI | 定義 |
|---|---|
| 純売上 `salesTotal` | Σ（`total − refunded_total`）— 1.4 の売上対象会計 |
| 施術売上 `serviceSales` / 店販売上 `productSales` | 1.5 の按分結果の合計 |
| 値引額 `discountTotal` | Σ `transactions.discount_total`（来店扱いの会計のみ） |
| 消費税 `taxTotal` | 1.5-4 の合計（内税） |
| 返金額 `refundTotal` | Σ `refunded_total`（元の会計日に計上） |
| 会計件数 `transactionCount` | 来店扱いの会計（completed / partially_refunded）の件数 |
| 延べ客数 `customerCount` | 店舗×日ごとの「異なる顧客数 + 顧客未登録の会計件数」を期間で合計（同じ顧客が別の日に来れば2） |
| 新規客数 / 再来客数 | 店舗×日ごとの異なる顧客のうち新規 / それ以外（§4.1の新規判定）を期間で合計。未登録客はどちらにも含めない |
| **客単価** `avgTicket` | 純売上 ÷ 延べ客数（四捨五入） |
| 会計単価 `avgTransactionValue` | 純売上 ÷ 会計件数 |
| 指名数 `nominatedCount` | 指名会計の件数。指名会計 = いずれかの明細担当が `is_nominated`、または紐づく予約が `is_nominated` |
| 指名率 `nominatedRate` | 指名数 ÷ 会計件数 |
| 新規率 `newCustomerRate` | 新規客数 ÷（新規客数 + 再来客数） |

- `groupBy=day|week|month`: 期間バケット（週は月曜始まり）。データの無い期間も0行で返却。
- `groupBy=shop`: 店舗別。`groupBy=staff` または `staffId` 指定: スタッフ別（`analytics_daily_staff` から。値引・税・会計件数はスタッフ単位では持たない）。

## 3. スタッフ生産性（`GET /v1/analytics/staff`）

| KPI | 定義 |
|---|---|
| 売上 | §1.5-3 のスタッフ配分額の合計（施術/店販別あり） |
| 担当客数 `customerCount` | 店舗×日ごとに、そのスタッフが **main** として担当した来店会計の「異なる顧客数 + 未登録客の会計件数」の合計 |
| 新規客数 | 担当客のうち新規 |
| 指名数 | main 担当の来店会計のうち、そのスタッフへの指名（明細の `is_nominated`、または予約の `is_nominated` かつ予約担当がそのスタッフ） |
| **指名率** | 指名数 ÷ 担当客数 |
| 客単価 | スタッフ売上 ÷ 担当客数 |
| 予約稼働時間 `bookedHours` | その日に開始する予約（tentative / confirmed / checked_in / in_service / completed）の施術時間（`end_at − start_at`、バッファ除く）の合計 |
| 勤務時間 `scheduledHours` | `schedules/calendar.ts` の `staffWorkRanges`（日別シフト → 週間パターン → 未設定なら営業時間、休業日・ブロック除外）の合計。対象は当日その店舗に所属する予約受付可スタッフ＋当日実績のあるスタッフ |
| 稼働1時間あたり売上 | 売上 ÷ 予約稼働時間 |
| 勤務1時間あたり売上 | 売上 ÷ 勤務時間 |
| **稼働率** `utilization` | 予約稼働時間 ÷ 勤務時間（勤務時間外の予約があると100%超もあり得る） |

## 4. 顧客KPI

### 4.1 用語

- **来店**: 顧客IDのある、completed / partially_refunded の会計。
- **新規来店**: `transactions.is_new_customer = true`。POSが NULL のときは「その顧客の法人内での最初の来店（`completed_at`, `id` 順）」。`false` は明示的に再来。
- **新規客**: 期間内・対象店舗での来店に新規来店を含む顧客。 **再来客**: 期間内に来店した新規客以外の顧客。

### 4.2 新規/再来/失客（`GET /v1/analytics/customers`）

| KPI | 定義 |
|---|---|
| 来店客数 `visitors` | 期間内に対象店舗で来店した **異なる顧客** の数（期間全体で重複排除。§2の延べ客数とは異なる） |
| 新規 `newCustomers` / 再来 `repeatCustomers` | §4.1。`visitors = newCustomers + repeatCustomers` |
| 再来率 `repeatRate` | 再来 ÷ 来店客数 |
| **失客** `lostCustomers` | **期間中に失客化した顧客数**。閾値 T 日（`lostThresholdDays`、既定90）として、`to` 時点での法人内の最終来店日が `[from − T, to − T]` に入り、かつその最終来店が対象店舗の顧客。すなわち「最終来店からT日経過」に期間内で到達し、期間末までに再来店していない顧客。最後に来店した店舗に帰属 |

> 失客の窓は「期間の各日 d に対し、最終来店 = d − T」を満たす範囲です。期間をずらさずに連続する期間の失客数を足し合わせると、その合計期間の失客数と一致します（二重計上なし）。
> 例: 期間 2025-06-01〜06-30・T=90 → 窓 2025-03-03〜04-01。3/20 が最終来店の顧客は失客、3/25 に来て 5/1 にも来た顧客は失客ではない。

**来店周期分布**（同レスポンス `visitCycle`）

- 対象: 期間内の来店客。来店は期間末（`to`）までを使用。
- 来店周期 = （最終来店 − 初回来店）÷（来店回数 − 1）［日、実時間］。来店1回の顧客は `singleVisitCustomers`。
- 階級: 〜30日 / 31〜45日 / 46〜60日 / 61〜90日 / 91〜120日 / 121日〜（上限を含む）。平均・中央値も返却。
- `rows` は日次集計（店舗×日の新規/再来）の期間バケット合計（延べ）。

### 4.3 新規リピート率（`GET /v1/analytics/repeat-rate`）

- **コホート**: 新規来店が期間内・対象店舗にある顧客（初回日時 = その新規来店）。`groupBy=month|week` で初回時期別。
- **N日リピート**（N = 30 / 60 / 90）: 初回来店後 N×24時間以内に、法人内のいずれかの店舗で次の来店がある。
- **対象数** `eligible`: 初回 + N日 ≤ 現在（観測期間を満了した顧客のみ。直近の新規が率を不当に下げないため）。
- **N日リピート率** = リピートした対象数 ÷ 対象数。
- `returnedEverRate`: 現時点までに2回目来店がある割合（満了条件なし）。
- `overallRepeatRate`: §4.2 の再来率（再来客 ÷ 来店客）。

### 4.4 LTV（`GET /v1/analytics/ltv`）

- 対象顧客: 法人内の初回来店が対象店舗である顧客（獲得店舗）。`from`/`to` 指定時は初回来店日で絞り込み。
- 売上は法人内の全店舗の純売上（来店扱いの会計の `total − refunded_total`）。
- **LTV（累計）** `ltvAllTime` = Σ 現在までの純売上 ÷ 顧客数。
- **LTV（12ヶ月）** `ltv12m` = Σ 初回来店から365日以内の純売上 ÷ 初回来店から365日以上経過した顧客数（`maturedCustomers`、未満了の顧客は除外）。
- 平均来店回数、客単価（累計純売上 ÷ 来店回数）も併記。
- 内訳: 来店きっかけ `customers.acquisition_source`（空は「不明」）/ 初回来店店舗 / 初回来店月。
- 上位顧客 `topCustomers`: 累計純売上順。呼び出しユーザーが閲覧できる顧客（`visibleCustomerFilter`）のみ。

## 5. メニュー構成比（`GET /v1/analytics/menus`）

- 対象: `item_type = service` かつ `menu_id` のある明細。
- 件数 = Σ数量（来店扱いの会計のみ）。売上 = §1.5 按分後の金額（全額返金会計は0）。
- 件数構成比 = メニュー件数 ÷ 全メニュー件数、売上構成比 = メニュー売上 ÷ 全メニュー売上。カテゴリ別（未設定は「未分類」）も同様。
- 指名料・店販はメニュー構成比に含めません（店販は §2 の店販売上）。

## 6. 予約経路別（`GET /v1/analytics/channels`）

| KPI | 定義 |
|---|---|
| 予約数 | その日に開始する予約数（キャンセル・無断キャンセルを含む）を `appointments.source` 別に |
| 来店完了数 / 来店完了率 | status = completed の予約数 / 来店完了数 ÷ 予約数 |
| 売上 | 会計に紐づく予約の経路へ純売上を帰属。予約の無い会計は `none`（予約なし・直接会計） |
| 売上構成比 | 経路別売上 ÷ 売上合計 |

経路ラベル: web=Web予約 / line=LINE予約 / external=外部予約媒体 / phone=電話 / walk_in=飛び込み / staff=スタッフ登録 / none=予約なし(直接会計)。

## 7. 期間比較（全レポート共通 `compareTo`）

- `previous_period`（既定）: 同じ日数だけ直前の期間（例: 6/1〜6/30 → 5/2〜5/31）。
- `previous_year`: 1年前の同じ日付（2/29 は 2/28）。
- `none`: 比較なし。
- 増減率 = （今期 − 前期）÷ 前期 × 100。前期が0なら `null`。

## 8. ダッシュボード（`GET /v1/analytics/dashboard?shopId&date`）

`date`（既定: 今日）は集計テーブルを待たずに **ライブ計算**、前日までは集計テーブル。

| KPI | 定義 |
|---|---|
| 本日予約数 | 当日開始の予約のうち tentative / confirmed / checked_in / in_service / completed |
| 確定売上 | 当日の純売上（§2と同定義、ライブ） |
| **見込売上** | 確定売上 + 売上対象会計がまだ無い当日予約（上記ステータス）の `estimated_total` 合計 |
| 新規客数・キャンセル・無断キャンセル | 当日分 |
| 月初来売上 | 当月1日〜前日の `analytics_daily_shop.sales_total` + 当日の確定売上 |
| 月間目標 | `organizations.settings.monthlyTargets[shopId]`（無ければ `settings.monthlyTarget`）。未設定は `null` |
| 達成率 | 月初来売上 ÷ 月間目標 |
| ペース | 月初来売上 ÷（月間目標 × 経過日数 ÷ 当月日数） |

## 9. AI拡張（`/v1/ai/*`）

### 9.1 失客リスク・次回来店予測（`heuristic-v1`、毎日 5:00 JST に法人ごとに `customer_scores` を更新）

```
想定周期 C = 顧客の平均来店周期（来店2回以上） | 法人の中央値周期 | 60日   （7〜365日に丸め）
r          = 最終来店からの日数 ÷ C
基礎リスク  = 1 / (1 + exp(−3 × (r − 1.5)))          … r = 1.5 で 0.5
リスク      = min(1, 基礎リスク + 0.05 × min(無断キャンセル回数, 3))
未来予約あり → リスク × 0.2
レベル      = high ≥ 0.7 > medium ≥ 0.4 > low
次回来店予測 = 未来予約日 | 最終来店 + C
期待LTV(12ヶ月) = 客単価(累計売上÷来店回数) × (365 ÷ C) × (1 − リスク)
```

推奨アクション例: `来店周期を45日超過: フォローメッセージ推奨` / `初回来店から70日経過・再来なし: 2回目来店のフォローメッセージ推奨` / `次回予約あり(2026-01-04): 予約前リマインドのみで可`。
入力特徴量は `customer_scores.features` に保存（説明可能性）。

### 9.2 売上予測（`GET /v1/ai/forecast?shopId&days`）

- 予測期間: 明日から `days` 日（最大90日）。
- ベースライン: 予測日と同じ曜日の、今日より前の直近8回（8週）の `analytics_daily_shop.sales_total` の平均（集計行が無い日は0）。
- 予約済み見積: その日の tentative / confirmed / checked_in / in_service 予約の `estimated_total` 合計。
- **予測値 = max(ベースライン, 予約済み見積)**（過去実績には予約売上が含まれるため、単純加算による二重計上を避け、予約済み額を下限とする）。
- 信頼帯 = 予測値 ± σ（同じ8日分の母標準偏差）、下限は予約済み見積を下回らない。

### 9.3 生成AI（人の承認が必須）

- 出力はすべて `ai_suggestions`（status = proposed）に保存。承認（accept）は本文を返すだけで、**メッセージ送信・配信予約・キャンペーン作成は一切行わない**（要件19.1）。
- 外部APIへ送るのは名（first name）と来店サマリー（来店回数・最終来店日・直近メニュー名）のみ。姓・電話・メール・住所・生年月日は送信しない。カルテメモ・口コミ本文は電話番号・メール・郵便番号をマスクしてから送信。
- `ANTHROPIC_API_KEY` 未設定時、または API 失敗時は決定的な日本語テンプレート（heuristic）で生成し、失敗理由を `output.fallbackReason` に記録。
- 法人設定 `settings.ai_assist === false` の場合、`/v1/ai/*` はすべて 403（`AI_DISABLED`）。

---

## 10. 権限・監査

| 権限 | 閲覧範囲 |
|---|---|
| `analytics.read`（売上は `sales.read` でも可） | アクセス可能な全店舗（全店舗ロールは法人全体）。`shopId` で絞り込み |
| `analytics.read_own` / `sales.read_own`（スタイリスト） | `/analytics/sales` と `/analytics/staff` の **自分のスタッフ数値のみ**。店舗合計・店舗別・他スタッフ指定・顧客/メニュー/経路/LTV/ダッシュボードは 403 |
| `export.data` | `?format=csv`（UTF-8 BOM付き）。監査 `export.csv`（`metadata.kind = analytics.<report>`） |
| `ops.manage` | 再集計 `POST /analytics/rebuild`、スコア再計算 `POST /ai/scores/recompute` |

売上を含むレポートの閲覧はすべて監査 `sales.view`（`metadata.report`・対象店舗・期間）を記録（要件2.1）。

---

## 11. 計算例（統合テストのデータセット）

店舗 1、日付 2025-06-12（木、営業 10:00–20:00）。

| 会計 | 内容 | 純額 |
|---|---|---|
| T1 | 新規C1: カット5,500[A・指名] + シャンプー3,300[A紹介] − 値引880 = 7,920 | 7,920（カット 4,950 / 店販 2,970 に按分） |
| T2 | 再来C2: カラー8,800[B 70% / A 30%]、1,100返金 | 7,700（B 5,390 / A 2,310） |
| T3 | 新規C3（POSフラグ）: カット5,500[B]、予約は指名 | 5,500 |
| T4 | 未登録客: 店販2,200[B] | 2,200 |
| T5 | 取消 | 計上しない |
| T6 | 全額返金 5,500 | 0（来店に数えない） |

- 純売上 23,320 = 施術 18,150 + 店販 5,170、値引 880、税 2,120（720 + 700 + 500 + 200 + 0）、返金 6,600
- 会計件数 4、延べ客数 4（C1/C2/C3 + 未登録1）、新規 2、再来 1、指名 2 → 客単価 5,830、指名率 50.0%
- スタッフA: 売上 10,230、担当客 1、勤務 600分・予約 60分 → 稼働率 10.0%、勤務1時間あたり 1,023円
- スタッフB: 売上 13,090、担当客 3、指名率 33.3%、勤務 360分（シフト 12–18時）・予約 150分 → 稼働率 41.7%、稼働1時間あたり 5,236円
- 前期（5/2〜5/31）売上 5,500 → 売上増減率 +324.0%

---

## 12. 既知の制約

- 返金は元の会計日に計上するため、過去日の数値が後から変わり得ます（夜間に直近3日を自動再集計、それ以前は手動再集計）。
- デバウンス中（最大約30秒）は当日以外の集計に変更が反映されません。当日はダッシュボードがライブ計算。
- 顧客単位指標（§4）はライブ集計のため、大規模法人では応答に時間がかかる可能性があります（将来は顧客別日次スナップショット/ウェアハウスへ移行可能な設計）。
- スタッフの「担当客数」は main 担当のみ。アシスタントは売上配分のみ反映されます。
