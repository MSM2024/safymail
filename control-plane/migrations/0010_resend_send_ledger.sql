-- Shared account-wide Resend Free quota reservations and idempotent send ledger.
CREATE TABLE IF NOT EXISTS control_resend_send_requests (
 id TEXT PRIMARY KEY,
 provider_account_id TEXT NOT NULL REFERENCES control_provider_accounts(id) ON DELETE CASCADE,
 installation_id TEXT NOT NULL REFERENCES control_installations(id) ON DELETE CASCADE,
 idempotency_key TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','sent','failed','uncertain')),
 day_key TEXT NOT NULL, month_key TEXT NOT NULL,
 provider_message_id TEXT, error_code TEXT,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(provider_account_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_control_resend_quota_day ON control_resend_send_requests(provider_account_id,day_key,status);
CREATE INDEX IF NOT EXISTS idx_control_resend_quota_month ON control_resend_send_requests(provider_account_id,month_key,status);
CREATE INDEX IF NOT EXISTS idx_control_resend_installation ON control_resend_send_requests(installation_id,created_at DESC);
