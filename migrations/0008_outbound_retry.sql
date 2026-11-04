ALTER TABLE messages ADD COLUMN send_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN send_next_attempt_at TEXT;
ALTER TABLE messages ADD COLUMN send_last_error TEXT;
CREATE INDEX idx_messages_send_retry ON messages(delivery_status, send_next_attempt_at, created_at);
