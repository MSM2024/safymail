-- Add an importance marker independent from the existing starred marker.
ALTER TABLE messages ADD COLUMN is_important INTEGER NOT NULL DEFAULT 0 CHECK (is_important IN (0,1));
CREATE INDEX idx_messages_account_important ON messages(account_id, folder, is_important, received_at DESC);
