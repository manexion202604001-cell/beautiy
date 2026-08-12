# CLAUDE.md — サロン向けカルテ＆予約統合管理システム

## プロジェクト概要
LiME相当のサロン管理SaaSを自社オーダーメイドで開発する。
カルテ・予約・会計/POS・LINEメッセージ・分析を一気通貫で管理するマルチテナントシステム。
正式な要件は `docs/requirements.md`（要件定義書 v1.0）を必ず参照すること。

## 技術スタック（変更禁止。変更提案がある場合は実装前に必ず確認を取る）
- フロントエンド: React + TypeScript + Vite（PWA対応、スマホファースト）
- スタイリング: Tailwind CSS（UIデザインは別途支給されるため、初期実装は構造とロジック優先。仮UIはシンプルに）
- バックエンド: Supabase（PostgreSQL / Auth / Storage / Realtime / Edge Functions）
- 自動化・外部連携: n8n（manexion.app.n8n.cloud）— LINE連携・自動メッセージ・AI処理はn8n側Webhookに委譲
- AI: Claude API（Edge Function経由で呼び出し。APIキーはフロントに絶対に置かない）

## 絶対に守るルール

### セキュリティ（最重要）
1. 全テーブルにRLS（Row Level Security）を有効化する。RLSなしのテーブル作成は禁止
2. テナント分離: 全テーブルに `tenant_id` を持たせ、RLSポリシーで強制する
3. カルテ写真は非公開バケット + 署名付きURL（有効期限1時間）でのみ配信
4. `service_role` キーはEdge Functions内のみで使用。クライアントコードに含めない
5. 会計データ（payments）は確定後UPDATE禁止。修正は打消し伝票方式（マイナス伝票 + 新伝票）
6. 個人情報の閲覧・エクスポート・会計修正は `audit_logs` に必ず記録する

### データモデル
- 顧客（customers）には所有権カラム `owner_type: 'salon' | 'staff'` を持たせる
- 顧客削除は論理削除（`deleted_at`）。カルテ・会計は匿名化して保持
- 予約の排他制御: `reservations` に PostgreSQL の排他制約（EXCLUDE USING gist）を使い、
  同一 staff_id / 同一 resource_id の時間帯重複をDB層でブロックする（アプリ層チェックだけに頼らない）
- マイグレーションは supabase/migrations/ に連番SQLで管理。手動でのスキーマ変更禁止

### コーディング規約
- TypeScript strict モード。`any` 禁止
- DBアクセスは `src/lib/api/` 配下のリポジトリ層に集約。コンポーネントから直接 supabase client を叩かない
- 日付処理は date-fns、タイムゾーンは Asia/Tokyo 固定
- 金額は整数（円）で扱う。浮動小数点での金額計算禁止
- コミットは Conventional Commits（feat: / fix: / chore:）。1機能1コミット
- 各フェーズ完了時に `docs/requirements.md` 10章の受け入れ基準に対応するテストを書く（Vitest）

### UI について
- UIビジュアルデザインは別工程で支給される。今は以下だけ守る:
  - コンポーネントはロジック（hooks）と表示を分離し、後からデザイン差し替え可能にする
  - 画面構成は要件定義書 7章の画面一覧（S-01〜S-13, C-01〜C-03）に準拠
  - スマホ幅（375px）を基準に実装

## 実装フェーズ（この順で進める。先のフェーズに手を出さない）

### Phase 1-A: 基盤（最初にやる）
1. Supabaseプロジェクト初期化、マイグレーション基盤
2. スキーマ作成: tenants, salons, staff, customers, menus, resources + RLSポリシー
3. 認証（メール+パスワード、スタッフ招待フロー）、ロール管理（owner/manager/stylist/assistant/freelance）
4. 監査ログ基盤

### Phase 1-B: カルテ
5. 顧客CRUD + 検索（カナ・電話部分一致）+ タグ + 警告表示
6. カルテ（施術履歴・レシピ構造化入力・メモ・写真アップロード）
7. カウンセリングシート（サロン側カスタマイズ + 顧客事前記入用公開フォーム）
8. CSVインポート/エクスポート

### Phase 1-C: 予約
9. 予約CRUD + 排他制御 + カレンダービュー（日/週/スタッフ別）
10. スタッフ個人設定（受付時間・休日・個人料金）
11. 顧客向けWeb予約ページ（空き枠計算 → 予約確定）

### Phase 1-D: 会計・連携
12. 会計（下書き→確定、複合支払、指名/フリー区分）、レジ締め、領収書PDF（インボイス番号印字）
13. n8n Webhook連携ポイント実装（予約確定/前日/来店後トリガーをn8nに送信）
14. 基本レポート（売上・顧客分析）

## n8n連携の設計方針
- 本システム→n8n: Supabase Database Webhooks または Edge Function から n8n Webhook URL にPOST
- n8n→本システム: 専用のAPIキー認証付きEdge Function エンドポイントを用意（例: /functions/v1/n8n-gateway）
- LINE Messaging API の処理は全てn8n側。本システムはメッセージ履歴の保存と表示のみ担当

## 質問すべきタイミング
- スキーマ設計で要件定義書と矛盾を見つけたとき
- 外部サービス（LINE/Square）の認証情報が必要になったとき
- 要件にない機能を追加したくなったとき（勝手に追加しない）
