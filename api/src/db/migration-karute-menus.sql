-- karute_menus: Junction table for karute-menu selection (multiple menus per karute)
CREATE TABLE IF NOT EXISTS karute_menus (
    id TEXT PRIMARY KEY,
    karute_id TEXT NOT NULL REFERENCES karutes(id) ON DELETE CASCADE,
    menu_id TEXT REFERENCES menus(id) ON DELETE SET NULL,
    menu_name TEXT NOT NULL,
    price INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_karute_menus_karute ON karute_menus(karute_id);

-- Add new columns to karutes table
ALTER TABLE karutes ADD COLUMN memo TEXT;
ALTER TABLE karutes ADD COLUMN assistant_memo TEXT;
