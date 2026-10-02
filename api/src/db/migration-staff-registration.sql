-- Migration: Staff self-registration with email verification and numeric IDs
ALTER TABLE staff ADD COLUMN staff_code TEXT;
ALTER TABLE staff ADD COLUMN email_verified INTEGER DEFAULT 0;
ALTER TABLE staff ADD COLUMN verification_token TEXT;
ALTER TABLE staff ADD COLUMN verification_token_expires_at TEXT;

-- Create unique index for staff_code (allows NULL values)
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_code ON staff(staff_code);

-- Grandfather existing staff as verified
UPDATE staff SET email_verified = 1;
