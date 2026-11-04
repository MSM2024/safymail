ALTER TABLE control_installations ADD COLUMN provision_lock TEXT;
ALTER TABLE control_installations ADD COLUMN lock_expires_at TEXT;
CREATE INDEX IF NOT EXISTS idx_control_installations_lock ON control_installations(status,lock_expires_at);
