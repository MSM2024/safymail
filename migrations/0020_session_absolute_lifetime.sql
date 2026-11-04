-- Enforce the new 12-hour absolute session lifetime for sessions created under the previous 30-day policy.
UPDATE auth_sessions
SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+12 hours')
WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+12 hours');
