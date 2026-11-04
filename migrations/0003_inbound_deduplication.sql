CREATE UNIQUE INDEX idx_messages_account_message_id
ON messages(account_id, message_id_header)
WHERE message_id_header IS NOT NULL AND message_id_header != '';
