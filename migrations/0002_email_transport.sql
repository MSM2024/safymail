ALTER TABLE messages ADD COLUMN raw_storage_key TEXT;
ALTER TABLE messages ADD COLUMN provider_message_id TEXT;
ALTER TABLE messages ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'received'
  CHECK (delivery_status IN ('received','queued','sent','delivered','bounced','failed'));
CREATE INDEX idx_messages_provider_id ON messages(provider_message_id);

CREATE TABLE provider_integrations (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES companies(id),
  provider TEXT NOT NULL CHECK (provider IN ('cloudflare_email','resend')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','error')),
  public_config_json TEXT NOT NULL DEFAULT '{}',
  secret_reference TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(company_id, provider)
);

CREATE INDEX idx_messages_delivery_status ON messages(delivery_status, created_at);
CREATE INDEX idx_webhook_events_pending ON webhook_events(processed_at, created_at);
