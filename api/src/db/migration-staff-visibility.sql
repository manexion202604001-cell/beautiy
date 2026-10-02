-- Add visibility toggle for customer-facing staff display
ALTER TABLE staff ADD COLUMN is_visible_to_customer INTEGER DEFAULT 1;
