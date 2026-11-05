import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const login = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
const security = readFileSync(new URL("./security.ts", import.meta.url), "utf8");

test("enrolled MFA users without a stored TOTP secret cannot authenticate by password alone", () => {
  const section = login.split('auth.post("/login"')[1]?.split('function base64Token()')[0] || "";
  const guard = section.indexOf("if (user.totp_enabled_at && !user.totp_secret_ciphertext)");
  const session = section.indexOf("await createSession(c,user.id,false)");
  assert.ok(guard > 0 && session > guard);
  assert.match(section.slice(guard,session),/mfa_unavailable/);
});

test("administrator password changes require a verified MFA session", () => {
  const section = security.split('security.post("/password"')[1]?.split('security.post("/totp/enroll"')[0] || "";
  const guard = section.indexOf("user.isSuperadmin && !user.mfaVerified");
  const update = section.indexOf("UPDATE users SET password_hash");
  assert.ok(guard > 0 && update > guard);
  assert.match(section.slice(guard,update),/mfa_verification_required/);
});
