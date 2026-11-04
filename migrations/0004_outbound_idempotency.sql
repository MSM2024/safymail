ALTER TABLE messages ADD COLUMN client_request_id TEXT;
CREATE UNIQUE INDEX idx_messages_account_client_request
ON messages(account_id, client_request_id)
WHERE client_request_id IS NOT NULL AND client_request_id != '';
