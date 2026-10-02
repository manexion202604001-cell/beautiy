-- Add is_new_customer column to reservations for manual new/repeat override
ALTER TABLE reservations ADD COLUMN is_new_customer INTEGER;
