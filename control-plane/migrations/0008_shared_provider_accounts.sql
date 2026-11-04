-- Shared, long-lived provider authorization bundle.
-- Secrets remain AES-GCM encrypted with CONTROL_PLANE_VAULT_KEY; plaintext is never stored.
CREATE TABLE IF NOT EXISTS control_provider_accounts (
  id TEXT PRIMARY KEY,
  cloudflare_account_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
  credentials_ciphertext TEXT NOT NULL,
  credentials_nonce TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'AES-GCM-256' CHECK(algorithm = 'AES-GCM-256'),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','revoked')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_control_provider_accounts_status
  ON control_provider_accounts(status, updated_at DESC);

ALTER TABLE control_installations
  ADD COLUMN provider_account_id TEXT REFERENCES control_provider_accounts(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_control_installations_provider_account
  ON control_installations(provider_account_id, created_at);

-- A provider bundle can manage at most two domains. Count all linked installations,
-- including failed/cancelled ones, because provider resources may already exist.
CREATE TRIGGER IF NOT EXISTS trg_provider_account_max_two_insert
BEFORE INSERT ON control_installations
WHEN NEW.provider_account_id IS NOT NULL
 AND (SELECT COUNT(*) FROM control_installations WHERE provider_account_id = NEW.provider_account_id) >= 2
BEGIN
  SELECT RAISE(ABORT, 'provider_account_domain_limit_reached');
END;

CREATE TRIGGER IF NOT EXISTS trg_provider_account_max_two_update
BEFORE UPDATE OF provider_account_id ON control_installations
WHEN NEW.provider_account_id IS NOT NULL
 AND NEW.provider_account_id <> COALESCE(OLD.provider_account_id, '')
 AND (SELECT COUNT(*) FROM control_installations WHERE provider_account_id = NEW.provider_account_id) >= 2
BEGIN
  SELECT RAISE(ABORT, 'provider_account_domain_limit_reached');
END;

-- Shared provider-level secrets (e.g. the single Resend webhook signing secret).
CREATE TABLE IF NOT EXISTS control_provider_secrets (
  provider_account_id TEXT NOT NULL REFERENCES control_provider_accounts(id) ON DELETE CASCADE,
  secret_name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'AES-GCM-256',
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(provider_account_id, secret_name)
);
