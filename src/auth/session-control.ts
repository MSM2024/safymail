/** Session management SQL never returns session bearer tokens or their hashes. */
export const LIST_ACTIVE_SESSIONS_SQL = `
SELECT id, created_at, last_seen_at, expires_at,
  CASE WHEN token_hash = ? THEN 1 ELSE 0 END AS is_current
FROM auth_sessions
WHERE user_id = ? AND expires_at > ? AND last_seen_at > ?
ORDER BY last_seen_at DESC
LIMIT 100
`;

export const REVOKE_OTHER_SESSIONS_SQL =
  "DELETE FROM auth_sessions WHERE user_id = ? AND token_hash <> ?";

/** Keep the active request's session while revoking all other devices. */
export async function listActiveSessions(
  db: D1Database, userId: string, currentTokenHash: string,
  now = new Date()
) {
  return db.prepare(LIST_ACTIVE_SESSIONS_SQL)
    .bind(currentTokenHash,userId,now.toISOString(),
      new Date(now.getTime()-2*60*60*1000).toISOString())
    .all<{id:string;created_at:string;last_seen_at:string;expires_at:string;is_current:number}>();
}
