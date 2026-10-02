-- Migration: Add Salonboard sync tracking to reservations and HPB email to stores
-- Run against both salon-db-dev and salon-db

-- Track Salonboard sync status per reservation
-- 0 = not synced, 1 = synced successfully, -1 = sync failed
ALTER TABLE reservations ADD COLUMN salonboard_synced INTEGER DEFAULT 0;
ALTER TABLE reservations ADD COLUMN salonboard_synced_at TEXT;
ALTER TABLE reservations ADD COLUMN salonboard_sync_error TEXT;

-- HPB email address for receiving Hot Pepper Beauty reservation notifications
-- Referenced by email-worker but previously missing from schema
ALTER TABLE stores ADD COLUMN hpb_email TEXT;
