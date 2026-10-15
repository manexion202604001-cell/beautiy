-- =====================================================================
-- 0171 Menu category colour (SALOGIC parity: reservations are coloured by the menu's category)
--   '#rrggbb'; NULL = no colour (the reservation keeps its status colour)
-- =====================================================================
ALTER TABLE menu_categories ADD COLUMN color text CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$');
