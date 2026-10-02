-- カウンセリングシート（お客様1人につき1つ、店舗ごと）
CREATE TABLE IF NOT EXISTS counseling_sheets (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(store_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_counseling_sheets_customer ON counseling_sheets(customer_id);
CREATE INDEX IF NOT EXISTS idx_counseling_sheets_store ON counseling_sheets(store_id);
