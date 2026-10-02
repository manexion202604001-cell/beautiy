-- 受付QR（スタッフ別）からの同意書・カウンセリング保留レコード
-- ※既存DB用。手動で実行: wrangler d1 execute <db> --remote --file=./src/db/migration-walkin.sql

CREATE TABLE IF NOT EXISTS walkin_intakes (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    staff_id TEXT REFERENCES staff(id) ON DELETE SET NULL,
    consent_record_id TEXT REFERENCES consent_records(id),
    customer_name TEXT NOT NULL DEFAULT '',
    customer_name_kana TEXT,
    customer_phone TEXT,
    customer_birthday TEXT,
    customer_gender TEXT CHECK(customer_gender IN ('male','female','other')),
    counseling_data TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','linked','created','discarded')),
    customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
    consent_submitted_at TEXT,
    counseling_submitted_at TEXT,
    resolved_at TEXT,
    resolved_by TEXT REFERENCES staff(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_walkin_store_status ON walkin_intakes(store_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_walkin_name ON walkin_intakes(customer_name);
