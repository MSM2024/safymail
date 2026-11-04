CREATE TABLE IF NOT EXISTS control_maintenance_dispatches (
  installation_id TEXT NOT NULL REFERENCES control_installations(id) ON DELETE CASCADE,
  scheduled_slot TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (installation_id, scheduled_slot)
);
CREATE INDEX IF NOT EXISTS idx_control_maintenance_slot ON control_maintenance_dispatches(scheduled_slot);
