# 実装ロードマップ — マスター要件定義書とのギャップ管理

`docs/master-requirements.md`（v1.0）の優先順位（§95）に沿って、現在の実装状況と次の開発対象を管理する。

最終更新: 2026-08-13

## Priority S — 基盤（コア）

| 領域 | 状況 | 備考 |
|---|---|---|
| Customer（顧客CRUD・検索・タグ・警告・所有区分） | ✅ 実装済 | CUSTOMER-001〜003, 007。名寄せ/統合（005-006）は未 |
| Customer Timeline（§88） | ✅ 実装済 | 予約/カルテ/会計/メッセージを顧客詳細で統一時系列表示 |
| Reservation（作成・状態・競合判定・カレンダー） | ✅ 実装済 | 状態は簡易版5種。§63の8状態への拡張は未。ドラッグ変更（007）未 |
| Availability Engine | ✅ 実装済 | 純関数 + テスト。勤務時間・設備Capacity考慮（004）は未 |
| Karte（施術記録・レシピ・メモ） | ✅ 実装済 | 写真加工/スケッチ/テンプレート/音声（005-009）は未 |
| Staff / Shop | ✅ 基本実装 | 複数店舗所属・勤務時間・プライベート予定（002-004）は未 |
| Auth | 🔶 デモ実装 | Supabase Auth接続で本実装（migrations準備済） |
| Multi Tenant Security | ✅ スキーマ実装済 | RLS + tenant_id 強制（supabase/migrations）。稼働はSupabase接続後 |

## Priority A

| 領域 | 状況 | 備考 |
|---|---|---|
| LINE（通知・リマインド・履歴） | 🔶 設計済 | n8n-gateway Edge Function 準備済。履歴表示UIあり |
| POS（複合支払・下書き・打消し伝票・レジ締め・領収書） | ✅ 実装済 | 値引き（POS-003）・税抜設定（004）・独自支払方法（006）は未 |
| Payment（Square等） | ⬜ 未着手 | PaymentProvider抽象化から着手（§23） |
| Reporting（売上・顧客・スタッフ別） | ✅ 基本実装 | 現状は固定サンプル値。実データ集計への切替が次段 |
| 次回来店予測・予約日提案（§20） | ✅ 実装済 | 平均来店周期から推奨日を算出し顧客詳細に表示 |
| LTV KPI（§32 LTV-001） | ✅ 実装済 | 累計売上/平均客単価/来店回数/平均周期を顧客詳細に表示 |
| 失客候補（LTV-003） | ✅ 実装済 | 周期×1.5 でダッシュボードに表示 |

## Priority B

| 領域 | 状況 |
|---|---|
| External Booking（Adapter方式 §26） | ⬜ 未着手 |
| Review（§30） | ⬜ 未着手 |
| Google Business Profile（§28） | ⬜ 未着手 |
| CRM Automation（セグメント配信 §18） | ⬜ 未着手（n8n側ワークフローで実装予定） |
| 公開プロフィール（§29） | ⬜ 未着手 |

## Priority C

| 領域 | 状況 |
|---|---|
| EC / 回数券 / ポイント / クーポン | ⬜ 未着手（Ledger型で設計する §62） |
| Advanced LTV / セグメント分析 | ⬜ 未着手 |
| AI機能群（§86） | ⬜ 未着手（Claude API / Edge Function経由） |

## 設計原則の遵守状況（§87, §91）

- ✅ Customer中心設計: 予約・カルテ・会計・メッセージはすべて customerId で関連付け済み
- ✅ 金額はinteger（円）。float不使用
- ✅ 売上のDELETE取消なし（打消し伝票 = Ledger型）
- ✅ tenant_id をクライアントから信用しない（RLSでToken由来のテナントを強制）
- ⬜ Idempotency-Key（§41）: Supabase接続時にAPI層で実装
- ⬜ Webhook署名検証（§56）: n8n-gateway はAPIキー認証済み。署名+event_id冪等化は決済連携時に実装

## 用語対応表（既存実装 ↔ マスター要件）

| 既存（requirements.md / 実装） | マスター要件定義書 |
|---|---|
| tenant / tenants | Organization / organizations |
| salon / salons | Shop / shops |
| 会計 payments（打消し伝票） | Transaction + Refund Transaction |
| 施術履歴 kartes | Karte / Visit |

**【決定 2026-08-13】** スキーマ命名は現行の `tenants / salons` を維持する（オーナー確認済み・どちらでも可とのこと）。
マスター要件の Organization / Shop は概念名として読み替え、上表の対応で恒久運用する。以後この論点は再検討しない。
