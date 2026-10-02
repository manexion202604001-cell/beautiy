-- Migration: Add retired_at column for staff retirement tracking
ALTER TABLE staff ADD COLUMN retired_at TEXT;
