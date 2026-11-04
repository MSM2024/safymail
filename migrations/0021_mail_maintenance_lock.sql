CREATE TABLE IF NOT EXISTS mail_maintenance_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lock_token TEXT,
  lock_expires_at TEXT,
  last_completed_slot TEXT
);
INSERT OR IGNORE INTO mail_maintenance_lock (id, lock_token, lock_expires_at) VALUES (1, NULL, NULL);
