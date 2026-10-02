-- 同意書テンプレート
CREATE TABLE IF NOT EXISTS consent_templates (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    sections TEXT NOT NULL,
    form_fields TEXT,
    version TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_consent_templates_store ON consent_templates(store_id, is_active);

-- 同意記録
CREATE TABLE IF NOT EXISTS consent_records (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES consent_templates(id),
    store_id TEXT NOT NULL REFERENCES stores(id),
    customer_name TEXT NOT NULL,
    customer_birthday TEXT,
    customer_phone TEXT,
    customer_occupation TEXT,
    customer_visit_reason TEXT,
    template_snapshot TEXT NOT NULL,
    agreed_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_consent_records_template ON consent_records(template_id);
CREATE INDEX IF NOT EXISTS idx_consent_records_store ON consent_records(store_id, agreed_at);
