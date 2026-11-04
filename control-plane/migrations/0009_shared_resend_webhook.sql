-- Shared Resend webhook ingress and durable fan-out.
ALTER TABLE control_provider_accounts ADD COLUMN webhook_endpoint TEXT;

CREATE TABLE IF NOT EXISTS control_webhook_events (
  provider_account_id TEXT NOT NULL REFERENCES control_provider_accounts(id) ON DELETE CASCADE,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(provider_account_id, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_control_webhook_events_received
  ON control_webhook_events(received_at);

CREATE TABLE IF NOT EXISTS control_webhook_deliveries (
  provider_account_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES control_installations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  delivered_at TEXT,
  last_error TEXT,
  PRIMARY KEY(provider_account_id, provider_event_id, installation_id),
  FOREIGN KEY(provider_account_id, provider_event_id)
    REFERENCES control_webhook_events(provider_account_id, provider_event_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_control_webhook_deliveries_pending
  ON control_webhook_deliveries(provider_account_id, status, last_attempt_at);
