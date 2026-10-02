-- 名前重複の「統合しない」で除外したグループ
CREATE TABLE IF NOT EXISTS name_duplicate_dismissed (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    dismissed_by TEXT NOT NULL,
    dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (store_id) REFERENCES stores(id),
    FOREIGN KEY (dismissed_by) REFERENCES staff(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_name_dup_dismissed_store_name ON name_duplicate_dismissed(store_id, normalized_name);
