-- Add is_nominated column to reservations (1=指名, 0=フリー)
ALTER TABLE reservations ADD COLUMN is_nominated INTEGER NOT NULL DEFAULT 0;
