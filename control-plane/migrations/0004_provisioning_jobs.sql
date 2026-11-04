CREATE TABLE IF NOT EXISTS control_provisioning_jobs (
  installation_id TEXT PRIMARY KEY REFERENCES control_installations(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_control_provisioning_jobs_expiry ON control_provisioning_jobs(expires_at);
