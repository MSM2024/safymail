ALTER TABLE users ADD COLUMN totp_secret_ciphertext TEXT;
ALTER TABLE users ADD COLUMN totp_pending_secret_ciphertext TEXT;
ALTER TABLE users ADD COLUMN totp_pending_expires_at TEXT;
ALTER TABLE users ADD COLUMN totp_enabled_at TEXT;

ALTER TABLE auth_sessions ADD COLUMN mfa_verified INTEGER NOT NULL DEFAULT 0
  CHECK (mfa_verified IN (0,1));

CREATE TABLE auth_mfa_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_auth_mfa_challenges_expiry ON auth_mfa_challenges(expires_at);

CREATE TABLE auth_backup_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, code_hash)
);
CREATE INDEX idx_auth_backup_codes_user ON auth_backup_codes(user_id, used_at);
