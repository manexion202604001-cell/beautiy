-- Migration: Make reservations.menu_id nullable with ON DELETE SET NULL
-- This allows menus to be deleted without blocking on reservation foreign keys

-- Step 1: Create new table with nullable menu_id and ON DELETE SET NULL
CREATE TABLE IF NOT EXISTS reservations_new (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
    menu_id TEXT REFERENCES menus(id) ON DELETE SET NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'completed', 'cancelled', 'noshow')),
    memo TEXT,
    cancel_reason TEXT,
    reminder_sent_at TEXT,
    source TEXT DEFAULT 'web' CHECK(source IN ('web', 'line', 'phone', 'walk-in', 'hotpepper')),
    hotpepper_id TEXT,
    salonboard_synced INTEGER DEFAULT 0,
    salonboard_synced_at TEXT,
    salonboard_sync_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Step 2: Copy data
INSERT INTO reservations_new SELECT * FROM reservations;

-- Step 3: Drop old table
DROP TABLE reservations;

-- Step 4: Rename new table
ALTER TABLE reservations_new RENAME TO reservations;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_reservations_store_date ON reservations(store_id, start_at);
CREATE INDEX IF NOT EXISTS idx_reservations_staff_date ON reservations(staff_id, start_at);
CREATE INDEX IF NOT EXISTS idx_reservations_customer ON reservations(customer_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);
