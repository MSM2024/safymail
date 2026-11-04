ALTER TABLE control_installations ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_control_installations_idempotency
  ON control_installations(idempotency_key) WHERE idempotency_key IS NOT NULL;
