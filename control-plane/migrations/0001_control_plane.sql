CREATE TABLE IF NOT EXISTS control_installations (
 id TEXT PRIMARY KEY, app_name TEXT NOT NULL, worker_name TEXT NOT NULL UNIQUE,
 domain TEXT NOT NULL COLLATE NOCASE UNIQUE, admin_email TEXT NOT NULL COLLATE NOCASE,
 resend_region TEXT NOT NULL DEFAULT 'eu-west-1',
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','authorizing','discovering','planning','provisioning','configuring','waiting_dns','verifying','bootstrapping','ready','paused','failed','cancelled')),
 current_step TEXT, error_code TEXT, error_message TEXT,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_control_installations_status_updated ON control_installations(status,updated_at DESC);
CREATE TABLE IF NOT EXISTS control_checkpoints (
 id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES control_installations(id) ON DELETE CASCADE,
 step TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('completed','failed')),
 details_json TEXT NOT NULL DEFAULT '{}', idempotency_key TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(installation_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_control_checkpoints_installation ON control_checkpoints(installation_id,created_at);
CREATE TABLE IF NOT EXISTS control_secrets (
 installation_id TEXT NOT NULL REFERENCES control_installations(id) ON DELETE CASCADE,
 secret_name TEXT NOT NULL, ciphertext TEXT NOT NULL, nonce TEXT NOT NULL,
 algorithm TEXT NOT NULL DEFAULT 'AES-GCM-256',
 updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(installation_id,secret_name)
);
CREATE TABLE IF NOT EXISTS control_audit_logs (
 id TEXT PRIMARY KEY, installation_id TEXT REFERENCES control_installations(id) ON DELETE SET NULL,
 action TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('success','failure')),
 metadata_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_control_audit_installation_date ON control_audit_logs(installation_id,created_at DESC);
