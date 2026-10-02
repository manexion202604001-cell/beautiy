-- Intake sessions: tracks QR → LINE friend add → consent → counseling flow
CREATE TABLE IF NOT EXISTS intake_sessions (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id),
    staff_id TEXT REFERENCES staff(id),
    line_user_id TEXT NOT NULL,
    customer_id TEXT REFERENCES customers(id),
    session_type TEXT CHECK(session_type IN ('new', 'returning')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'name_input', 'consent', 'counseling', 'completed')),
    name TEXT,
    name_kana TEXT,
    gender TEXT CHECK(gender IN ('male', 'female', 'other')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_intake_sessions_line_user ON intake_sessions(line_user_id, store_id);
CREATE INDEX IF NOT EXISTS idx_intake_sessions_status ON intake_sessions(status, store_id);
