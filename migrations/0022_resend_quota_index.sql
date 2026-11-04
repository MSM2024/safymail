DROP INDEX IF EXISTS idx_messages_outbound_sent_at;
CREATE INDEX IF NOT EXISTS idx_messages_outbound_sent_at
ON messages(sent_at)
WHERE direction='outbound' AND sent_at IS NOT NULL;
