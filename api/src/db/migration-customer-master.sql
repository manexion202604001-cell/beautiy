-- 顧客マスタ（人物単位 / 店舗跨ぎ会員番号）の追加
-- ※既存DB用。migration-groups.sql を先に実行しておくこと。1回だけ実行する（ALTER は再実行不可）。

-- 顧客マスタ
CREATE TABLE IF NOT EXISTS customer_master (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id),
    seq INTEGER NOT NULL,
    member_no TEXT NOT NULL,              -- 例: "A01-M-0000123"
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(group_id, seq),
    UNIQUE(member_no)
);

-- グループ別 採番カウンタ
CREATE TABLE IF NOT EXISTS customer_master_seq (
    group_id TEXT PRIMARY KEY REFERENCES groups(id),
    next_val INTEGER NOT NULL
);

-- 既存の各グループに採番カウンタ行を用意（1から）
INSERT OR IGNORE INTO customer_master_seq (group_id, next_val)
SELECT id, 1 FROM groups;

-- customers に master_id を追加（NULL許容のため FK 付きで追加可能）
ALTER TABLE customers ADD COLUMN master_id TEXT REFERENCES customer_master(id);
CREATE INDEX IF NOT EXISTS idx_customers_master ON customers(master_id);
