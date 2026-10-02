-- Migration: Add Salonboard integration columns
-- Run these commands on both dev and production databases

-- Add salonboard columns to stores table
ALTER TABLE stores ADD COLUMN salonboard_id TEXT;
ALTER TABLE stores ADD COLUMN salonboard_password TEXT;
ALTER TABLE stores ADD COLUMN salonboard_enabled INTEGER DEFAULT 0;

-- Add hotpepper_id column to reservations table
ALTER TABLE reservations ADD COLUMN hotpepper_id TEXT;

-- Note: The source column constraint cannot be altered in SQLite
-- New values will work, but existing CHECK constraint may need to be recreated
-- if strict validation is required
