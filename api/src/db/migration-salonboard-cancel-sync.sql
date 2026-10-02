-- Migration: Add salonboard_cancel_synced to reservations table
-- Tracks whether a cancellation has been synced to Salonboard
-- 0 = not synced (or not cancelled), 1 = cancel synced
-- Run against both salon-db-dev and salon-db

ALTER TABLE reservations ADD COLUMN salonboard_cancel_synced INTEGER DEFAULT 0;
