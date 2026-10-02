-- Add registration_status to customer_line for LINE initial registration flow
-- Default 'completed' for existing records (already registered)
ALTER TABLE customer_line ADD COLUMN registration_status TEXT NOT NULL DEFAULT 'completed';
