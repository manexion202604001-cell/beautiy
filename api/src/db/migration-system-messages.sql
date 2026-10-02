-- メッセージにsystemディレクション追加（予約通知などのシステムメッセージ用）
-- D1/SQLiteはALTER TABLE ... MODIFY COLUMN未対応のため、CHECK制約の変更はカラムを追加する形では不可
-- 代わりにCHECK制約を無視して直接insertする（SQLiteのCHECK制約は既存データに影響しない）
-- 新しいテーブルを作り直す

-- 一時テーブルにデータ退避
CREATE TABLE messages_backup AS SELECT * FROM messages;

-- 旧テーブル削除
DROP TABLE messages;

-- 新テーブル作成（direction に 'system' 追加）
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    staff_id TEXT REFERENCES staff(id) ON DELETE SET NULL,
    direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing', 'system')),
    message_type TEXT NOT NULL CHECK(message_type IN ('text', 'image', 'sticker', 'audio', 'video', 'file', 'location')),
    content TEXT,
    line_message_id TEXT,
    source TEXT NOT NULL CHECK(source IN ('line', 'web')) DEFAULT 'line',
    is_read INTEGER DEFAULT 0,
    sent_by_staff_id TEXT REFERENCES staff(id) ON DELETE SET NULL,
    sent_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- データ復元
INSERT INTO messages SELECT id, store_id, customer_id, staff_id, direction, message_type, content, line_message_id, source, is_read, sent_by_staff_id, sent_at, created_at FROM messages_backup;

-- バックアップ削除
DROP TABLE messages_backup;

-- インデックス再作成
CREATE INDEX IF NOT EXISTS idx_messages_customer ON messages(customer_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_store_date ON messages(store_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_customer_staff ON messages(customer_id, staff_id, sent_at);
