-- Junction table for reservation-menus (multiple menus per reservation)
CREATE TABLE IF NOT EXISTS reservation_menus (
    id TEXT PRIMARY KEY,
    reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    menu_id TEXT REFERENCES menus(id) ON DELETE SET NULL,
    menu_name TEXT NOT NULL,
    duration INTEGER NOT NULL,
    price INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reservation_menus_reservation ON reservation_menus(reservation_id);
CREATE INDEX IF NOT EXISTS idx_reservation_menus_menu ON reservation_menus(menu_id);

-- Migrate existing data: reservations.menu_id → reservation_menus
INSERT OR IGNORE INTO reservation_menus (id, reservation_id, menu_id, menu_name, duration, price, sort_order)
SELECT
    'rm_' || r.id,
    r.id,
    r.menu_id,
    COALESCE(m.name, '不明なメニュー'),
    COALESCE(m.duration, 60),
    COALESCE(m.price, 0),
    0
FROM reservations r
LEFT JOIN menus m ON r.menu_id = m.id
WHERE r.menu_id IS NOT NULL;
