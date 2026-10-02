-- Migration: Add salonboard_reserve_id to reservations table
-- Stores the Salonboard reservation number (YG format, e.g. YG05406156)
-- Used for cancellation sync
-- Run against both salon-db-dev and salon-db

ALTER TABLE reservations ADD COLUMN salonboard_reserve_id TEXT;
