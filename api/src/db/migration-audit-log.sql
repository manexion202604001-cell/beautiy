-- Staff audit log for tracking data mutations (POST/PUT/DELETE)
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    staff_id TEXT REFERENCES staff(id) ON DELETE SET NULL,
    staff_name TEXT,
    staff_role TEXT,
    store_id TEXT,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    route_pattern TEXT,
    action TEXT,
    entity_type TEXT,
    entity_id TEXT,
    status_code INTEGER NOT NULL,
    request_summary TEXT,
    ip_address TEXT,
    user_agent TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_staff ON audit_logs(staff_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_store ON audit_logs(store_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
