-- Track synced menu names for detecting menu changes
ALTER TABLE reservations ADD COLUMN salonboard_synced_menu_names TEXT;
