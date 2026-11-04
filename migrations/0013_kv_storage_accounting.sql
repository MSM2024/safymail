CREATE TABLE mail_storage_reservations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  message_id TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','committed')),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_mail_storage_usage ON mail_storage_reservations(status, expires_at);
CREATE INDEX idx_mail_storage_company ON mail_storage_reservations(company_id, status);
