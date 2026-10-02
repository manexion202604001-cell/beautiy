-- Staff personal menus (private to each staff, not visible to customers)
CREATE TABLE IF NOT EXISTS staff_menus (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  duration INTEGER NOT NULL,
  price INTEGER NOT NULL,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_staff_menus_staff ON staff_menus(staff_id);
