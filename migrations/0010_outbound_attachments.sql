ALTER TABLE attachments ADD COLUMN content_hash TEXT;
CREATE INDEX idx_attachments_message_hash ON attachments(message_id, content_hash);
