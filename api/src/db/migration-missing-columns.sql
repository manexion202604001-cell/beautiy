-- コードが参照しているがスキーマ/既存マイグレーションに定義がなかったカラム・テーブルを追加
-- 既存DB向け。新規構築は schema.sql（本マイグレーション適用済み）を使うこと。
-- D1/SQLite は ADD COLUMN IF NOT EXISTS 未対応のため、既に存在するカラムは
-- "duplicate column name" エラーになる。その場合は該当行を除いて実行する。

-- stores: 予約受付設定（staff_reservation_settings と同じ項目の店舗デフォルト）
ALTER TABLE stores ADD COLUMN advance_booking_days INTEGER DEFAULT 365;
ALTER TABLE stores ADD COLUMN advance_booking_months INTEGER DEFAULT 4;
ALTER TABLE stores ADD COLUMN same_day_cutoff_hours INTEGER DEFAULT 1;
ALTER TABLE stores ADD COLUMN max_concurrent INTEGER DEFAULT 1;
ALTER TABLE stores ADD COLUMN accept_same_start_time INTEGER DEFAULT 0;
ALTER TABLE stores ADD COLUMN accept_outside_hours INTEGER DEFAULT 0;
ALTER TABLE stores ADD COLUMN holiday_hours_enabled INTEGER DEFAULT 0;
ALTER TABLE stores ADD COLUMN salonboard_restart_requested INTEGER DEFAULT 0;

-- staff: LINE通知・2段階認証・パスワードリセット・サロンボード表示名
ALTER TABLE staff ADD COLUMN line_user_id TEXT;
ALTER TABLE staff ADD COLUMN totp_secret TEXT;
ALTER TABLE staff ADD COLUMN password_reset_token TEXT;
ALTER TABLE staff ADD COLUMN password_reset_token_expires_at TEXT;
ALTER TABLE staff ADD COLUMN salonboard_name TEXT;

-- staff_stores: 店舗ごとのお客様向け表示可否
ALTER TABLE staff_stores ADD COLUMN is_visible_to_customer INTEGER DEFAULT 1;

-- customers: minimo経由の顧客（LINE自動通知を停止）
ALTER TABLE customers ADD COLUMN is_minimo INTEGER DEFAULT 0;

-- karutes: 顔図スケッチ（JSON）
ALTER TABLE karutes ADD COLUMN face_drawing TEXT;

-- menus: 新規客価格・「〜」表記
ALTER TABLE menus ADD COLUMN price_new INTEGER;
ALTER TABLE menus ADD COLUMN price_tilde INTEGER DEFAULT 0;

-- reservations: サロンボード予約経路・1週間前リマインド送信日時
ALTER TABLE reservations ADD COLUMN salonboard_route TEXT;
ALTER TABLE reservations ADD COLUMN week_reminder_sent_at TEXT;

-- LINEトーク上の予約フロー状態
CREATE TABLE IF NOT EXISTS line_sessions (
    line_user_id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    step TEXT NOT NULL,
    staff_id TEXT,
    menu_id TEXT,
    customer_type TEXT,
    date TEXT,
    time TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
