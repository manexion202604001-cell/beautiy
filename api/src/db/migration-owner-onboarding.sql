-- Add login_id for non-email login (owner accounts created by SE)
ALTER TABLE staff ADD COLUMN login_id TEXT DEFAULT NULL;

-- Flag to force password change on first login
ALTER TABLE staff ADD COLUMN must_change_password INTEGER DEFAULT 0;

-- Flag to track if owner has completed onboarding (default 1 for existing users)
ALTER TABLE staff ADD COLUMN onboarding_completed INTEGER DEFAULT 1;

-- Unique index on login_id (SQLite partial index)
CREATE UNIQUE INDEX idx_staff_login_id ON staff(login_id) WHERE login_id IS NOT NULL;
