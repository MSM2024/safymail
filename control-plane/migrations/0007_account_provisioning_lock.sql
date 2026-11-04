CREATE TABLE IF NOT EXISTS control_account_provisioning_locks (
  cloudflare_account_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES control_installations(id) ON DELETE CASCADE,
  lease_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_control_account_provisioning_locks_expiry
  ON control_account_provisioning_locks(expires_at);
