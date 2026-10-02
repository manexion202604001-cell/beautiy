-- Junction table for menu-staff assignments (which staff can perform each menu)
CREATE TABLE IF NOT EXISTS menu_staff (
    id TEXT PRIMARY KEY,
    menu_id TEXT NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
    staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(menu_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_menu_staff_menu ON menu_staff(menu_id);
CREATE INDEX IF NOT EXISTS idx_menu_staff_staff ON menu_staff(staff_id);
