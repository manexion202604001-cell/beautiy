-- Customer merge candidates table
-- Used when LINE webhook creates a new customer that may match an existing customer record
CREATE TABLE IF NOT EXISTS customer_merge_candidates (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    line_customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    existing_customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    line_display_name TEXT,
    match_type TEXT NOT NULL CHECK(match_type IN ('name', 'phone', 'name_kana')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'merged', 'skipped')),
    resolved_by TEXT REFERENCES staff(id) ON DELETE SET NULL,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(line_customer_id, existing_customer_id)
);
CREATE INDEX IF NOT EXISTS idx_merge_candidates_store_status
  ON customer_merge_candidates(store_id, status);
