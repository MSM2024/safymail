/**
 * One SQLite UPSERT increments the failed-login counter atomically.
 * All expressions in the DO UPDATE clause read the pre-update row,
 * so simultaneous requests cannot overwrite one another's increments.
 */
export const RECORD_FAILED_LOGIN_SQL = `
INSERT INTO auth_login_attempts(ip_hash,email,failed_count,window_started_at,locked_until)
VALUES (?,?,1,?,NULL)
ON CONFLICT(ip_hash,email) DO UPDATE SET
  failed_count = CASE
    WHEN window_started_at > ? THEN failed_count + 1 ELSE 1 END,
  locked_until = CASE
    WHEN window_started_at > ? AND failed_count >= 7 THEN ?
    ELSE NULL END,
  window_started_at = CASE
    WHEN window_started_at > ? THEN window_started_at ELSE excluded.window_started_at END
`;

export async function recordFailedLogin(
  db: D1Database,
  ipHash: string,
  email: string,
  now: Date
): Promise<void> {
  const timestamp = now.toISOString();
  const windowStart = new Date(now.getTime()-15*60*1000).toISOString();
  const lockUntil = new Date(now.getTime()+15*60*1000).toISOString();
  await db.prepare(RECORD_FAILED_LOGIN_SQL)
    .bind(ipHash,email,timestamp,windowStart,windowStart,lockUntil,windowStart)
    .run();
}
