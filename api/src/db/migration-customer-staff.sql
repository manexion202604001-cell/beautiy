-- 顧客担当スタッフ（複数担当対応）
CREATE TABLE IF NOT EXISTS customer_staff (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    is_primary INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(customer_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_staff_customer ON customer_staff(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_staff_staff ON customer_staff(staff_id);

-- Migrate existing staff_id data into customer_staff
INSERT OR IGNORE INTO customer_staff (id, customer_id, staff_id, is_primary)
SELECT
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))) as id,
    c.id as customer_id,
    c.staff_id as staff_id,
    1 as is_primary
FROM customers c
WHERE c.staff_id IS NOT NULL;
