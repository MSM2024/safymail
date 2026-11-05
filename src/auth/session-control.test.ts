import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LIST_ACTIVE_SESSIONS_SQL, REVOKE_OTHER_SESSIONS_SQL } from "./session-control";

test("session listing is user-scoped and excludes expired or idle sessions", () => {
  assert.match(LIST_ACTIVE_SESSIONS_SQL,/WHERE user_id = \?/);
  assert.match(LIST_ACTIVE_SESSIONS_SQL,/expires_at > \?/);
  assert.match(LIST_ACTIVE_SESSIONS_SQL,/last_seen_at > \?/);
  assert.match(LIST_ACTIVE_SESSIONS_SQL,/CASE WHEN token_hash = \? THEN 1 ELSE 0 END AS is_current/);
  assert.doesNotMatch(LIST_ACTIVE_SESSIONS_SQL,/SELECT[^]*token_hash\s*,/i);
});
test("other-device revocation retains the active session", () => {
  assert.match(REVOKE_OTHER_SESSIONS_SQL,/DELETE FROM auth_sessions WHERE user_id = \? AND token_hash <> \?/);
});
test("revocation requires password and active MFA when enrolled, and is audited", () => {
  const src=readFileSync(new URL("./security.ts",import.meta.url),"utf8");
  const section=src.split('security.post("/sessions/revoke-others"')[1]?.split('security.post("/totp/enroll"')[0] || "";
  assert.match(section,/verifyPassword\(body.current_password/);
  assert.match(section,/row.totp_enabled_at && !user.mfaVerified/);
  assert.match(section,/c.env.DB.batch\(\[/);
  assert.match(section,/REVOKE_OTHER_SESSIONS_SQL/);
  assert.match(section,/auth.other_sessions_revoked/);
  assert.doesNotMatch(section,/c.header\("Set-Cookie"/);
});
