-- スタッフ別営業時間（スタッフ+店舗単位）
CREATE TABLE IF NOT EXISTS staff_business_hours (
    id TEXT PRIMARY KEY,
    staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL,  -- 0=日, 1=月, ..., 6=土
    open_time TEXT,
    close_time TEXT,
    is_closed INTEGER DEFAULT 0,
    UNIQUE(staff_id, store_id, day_of_week)
);

CREATE INDEX IF NOT EXISTS idx_staff_bh_staff_store ON staff_business_hours(staff_id, store_id);
CREATE INDEX IF NOT EXISTS idx_staff_bh_store ON staff_business_hours(store_id);

-- スタッフ別予約設定（スタッフ+店舗単位）
CREATE TABLE IF NOT EXISTS staff_reservation_settings (
    id TEXT PRIMARY KEY,
    staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    advance_booking_days INTEGER DEFAULT 365,
    same_day_cutoff_hours INTEGER DEFAULT 1,
    max_concurrent INTEGER DEFAULT 1,
    accept_same_start_time INTEGER DEFAULT 0,
    accept_outside_hours INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(staff_id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_rs_staff_store ON staff_reservation_settings(staff_id, store_id);
