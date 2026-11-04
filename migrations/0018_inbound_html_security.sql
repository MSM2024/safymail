ALTER TABLE messages ADD COLUMN authentication_results TEXT;
ALTER TABLE messages ADD COLUMN spam_score INTEGER NOT NULL DEFAULT 0 CHECK (spam_score BETWEEN 0 AND 10);
ALTER TABLE messages ADD COLUMN spam_reasons_json TEXT NOT NULL DEFAULT '[]';
