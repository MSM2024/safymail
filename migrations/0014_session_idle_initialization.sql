UPDATE auth_sessions SET last_seen_at=created_at WHERE last_seen_at IS NULL;
