-- 予約アクティビティログ
CREATE TABLE IF NOT EXISTS reservation_logs (
    id TEXT PRIMARY KEY,
    reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK(actor_type IN ('staff', 'customer', 'system')),
    actor_id TEXT,
    actor_name TEXT,
    description TEXT NOT NULL,
    changes TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reservation_logs_reservation ON reservation_logs(reservation_id, created_at);
