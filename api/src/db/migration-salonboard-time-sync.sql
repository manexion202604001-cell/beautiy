-- Track synced time values for detecting time changes
ALTER TABLE reservations ADD COLUMN salonboard_synced_start_at TEXT;
ALTER TABLE reservations ADD COLUMN salonboard_synced_end_at TEXT;
