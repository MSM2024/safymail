import { Hono } from "hono";
import type { Env, AppVariables } from "../types";
import { getSessionToken, hashPassword, verifyPassword } from "../middleware/auth";
import { createOtpAuthUri, decryptTotpSecret, encryptTotpSecret, generateBackupCodes, generateTotpSecret, hashBackupCode, matchTotpCounter } from "./totp";

const security = new Hono<{ Bindings: Env; Variables: AppVariables }>();
function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 12 && value.length <= 256;
}

security.patch("/profile", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ display_name?: string }>().catch(() => ({} as any));
  const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
  if (!displayName || displayName.length > 120 || /[\r\n\u0000-\u001f\u007f]/.test(displayName)) {
    return c.json({ error: "invalid_display_name", message: "El nombre debe tener entre 1 y 120 caracteres y no contener saltos de línea." }, 400);
  }
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare("UPDATE users SET display_name=? WHERE id=? AND status='active'").bind(displayName, user.id)
  ];
  if (!user.isSuperadmin) {
    statements.push(c.env.DB.prepare("UPDATE email_accounts SET display_name=? WHERE id IN (SELECT ea.id FROM email_accounts ea JOIN company_memberships cm ON cm.company_id=ea.company_id AND cm.user_id=? JOIN account_permissions ap ON ap.account_id=ea.id AND ap.user_id=? AND ap.permission='read_write' WHERE ea.status='active' AND (? IS NULL OR ea.company_id=?))")
      .bind(displayName, user.id, user.id, c.get("hostCompanyId"), c.get("hostCompanyId")));
  }
  statements.push(c.env.DB.prepare(
    "INSERT INTO audit_logs(id,actor_user_id,action,resource_type,resource_id,metadata_json) VALUES(?,?,'user.profile_updated','user',?,?)"
  ).bind(crypto.randomUUID(), user.id, user.id, JSON.stringify({ display_name: displayName })));
  await c.env.DB.batch(statements);
  return c.json({ display_name: displayName, updated: true });
});

security.post("/password", async (c) => {
  const user = c.get("user");
  if (user.isSuperadmin && !user.mfaVerified) return c.json({error:"mfa_verification_required"},403);
  const body = await c.req.json<{ current_password?: string; new_password?: string }>().catch(() => ({} as any));
  if (typeof body.current_password !== "string" || body.current_password.length > 256 || !validPassword(body.new_password)) {
    return c.json({ error: "invalid_password", message: "Indica tu contraseña actual y una nueva contraseña de al menos 12 caracteres." }, 400);
  }
  const row = await c.env.DB.prepare("SELECT password_hash,password_salt FROM users WHERE id=? AND status='active'")
    .bind(user.id).first<{ password_hash: string | null; password_salt: string | null }>();
  if (!row?.password_hash || !row.password_salt ||
      !await verifyPassword(body.current_password, row.password_salt, row.password_hash)) {
    return c.json({ error: "invalid_credentials", message: "La contraseña actual no es correcta." }, 401);
  }
  if (await verifyPassword(body.new_password, row.password_salt, row.password_hash)) {
    return c.json({ error: "password_unchanged", message: "La nueva contraseña debe ser diferente de la actual." }, 400);
  }
  const token = getSessionToken(c.req.raw);
  if (!token) return c.json({ error: "session_required" }, 401);
  const tokenHash = base64Url(await digest(token));
  const credentials = await hashPassword(body.new_password);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash=?,password_salt=? WHERE id=?").bind(credentials.hash, credentials.salt, user.id),
    c.env.DB.prepare("DELETE FROM auth_sessions WHERE user_id=? AND token_hash<>?").bind(user.id, tokenHash),
    c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,action,resource_type,resource_id) VALUES(?,?,'user.password_changed','user',?)")
      .bind(crypto.randomUUID(), user.id, user.id)
  ]);
  return c.json({ password_updated: true, other_sessions_revoked: true });
});

security.post("/totp/enroll", async (c) => {
  const user = c.get("user");
  const row = await c.env.DB.prepare("SELECT email,totp_enabled_at FROM users WHERE id=? AND status='active'")
    .bind(user.id).first<{ email: string; totp_enabled_at: string | null }>();
  if (!row) return c.json({ error: "user_not_found" }, 404);
  if (row.totp_enabled_at) return c.json({ error: "totp_already_enabled" }, 409);
  let secret: string, ciphertext: string;
  try {
    secret = generateTotpSecret();
    ciphertext = await encryptTotpSecret(secret, c.env.TOTP_ENCRYPTION_KEY);
  } catch {
    return c.json({ error: "totp_encryption_key_missing", message: "La configuración de seguridad TOTP no está disponible. Contacta al administrador." }, 503);
  }
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await c.env.DB.prepare("UPDATE users SET totp_pending_secret_ciphertext=?,totp_pending_expires_at=?,totp_pending_attempts=0 WHERE id=?")
    .bind(ciphertext, expires, user.id).run();
  await c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,action,resource_type,resource_id) VALUES(?,?,'auth.totp_enrollment_started','user',?)")
    .bind(crypto.randomUUID(), user.id, user.id).run();
  return c.json({ secret, otpauth_uri: createOtpAuthUri(secret, row.email), expires_at: expires });
});

security.post("/totp/replace", async (c) => {
  const user = c.get("user");
  if (!user.mfaVerified) return c.json({ error: "mfa_verification_required" }, 403);
  const body = await c.req.json<{ password?: string }>().catch(() => ({} as any));
  if (typeof body.password !== "string" || body.password.length > 256) return c.json({ error: "invalid_credentials" }, 400);
  const row = await c.env.DB.prepare("SELECT email,password_hash,password_salt,totp_enabled_at FROM users WHERE id=? AND status='active'")
    .bind(user.id).first<{ email: string; password_hash: string | null; password_salt: string | null; totp_enabled_at: string | null }>();
  if (!row?.totp_enabled_at || !row.password_hash || !row.password_salt ||
      !await verifyPassword(body.password, row.password_salt, row.password_hash)) {
    return c.json({ error: "invalid_credentials" }, 401);
  }
  let secret: string, ciphertext: string;
  try {
    secret = generateTotpSecret();
    ciphertext = await encryptTotpSecret(secret, c.env.TOTP_ENCRYPTION_KEY);
  } catch {
    return c.json({ error: "totp_encryption_key_missing" }, 503);
  }
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await c.env.DB.prepare("UPDATE users SET totp_pending_secret_ciphertext=?,totp_pending_expires_at=?,totp_pending_attempts=0 WHERE id=? AND totp_enabled_at IS NOT NULL")
    .bind(ciphertext, expires, user.id).run();
  await c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,action,resource_type,resource_id) VALUES(?,?,'auth.totp_replacement_started','user',?)")
    .bind(crypto.randomUUID(), user.id, user.id).run();
  return c.json({ secret, otpauth_uri: createOtpAuthUri(secret, row.email), expires_at: expires });
});

security.post("/totp/confirm", async (c) => {
  const user = c.get("user"), body = await c.req.json<{ code?: string }>().catch(() => ({} as any));
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const row = await c.env.DB.prepare("SELECT totp_pending_secret_ciphertext,totp_pending_expires_at,totp_enabled_at,totp_pending_attempts FROM users WHERE id=? AND status='active'")
    .bind(user.id).first<{ totp_pending_secret_ciphertext: string | null; totp_pending_expires_at: string | null; totp_enabled_at: string | null; totp_pending_attempts: number }>();
  if (!row || (row.totp_enabled_at && !user.mfaVerified)) return c.json({ error: "totp_enrollment_unavailable" }, 409);
  if (!row.totp_pending_secret_ciphertext || !row.totp_pending_expires_at || Date.parse(row.totp_pending_expires_at) <= Date.now())
    return c.json({ error: "totp_enrollment_expired" }, 410);
  if (row.totp_pending_attempts >= 5) {
    await c.env.DB.prepare("UPDATE users SET totp_pending_secret_ciphertext=NULL,totp_pending_expires_at=NULL,totp_pending_attempts=0 WHERE id=?").bind(user.id).run();
    return c.json({ error: "totp_enrollment_attempts_exceeded" }, 429);
  }
  let secret: string;
  try { secret = await decryptTotpSecret(row.totp_pending_secret_ciphertext, c.env.TOTP_ENCRYPTION_KEY); }
  catch { return c.json({ error: "totp_unavailable" }, 503); }
  const matchedCounter = await matchTotpCounter(secret, code);
  if (matchedCounter === null) {
    await c.env.DB.prepare("UPDATE users SET totp_pending_attempts=totp_pending_attempts+1 WHERE id=? AND totp_pending_attempts<5").bind(user.id).run();
    return c.json({ error: "invalid_totp_code" }, 400);
  }
  const codes = generateBackupCodes(), hashes = await Promise.all(codes.map(hashBackupCode)), now = new Date().toISOString();
  const activation = await c.env.DB.prepare("UPDATE users SET totp_secret_ciphertext=totp_pending_secret_ciphertext,totp_pending_secret_ciphertext=NULL,totp_pending_expires_at=NULL,totp_pending_attempts=0,totp_enabled_at=?,totp_last_counter=? WHERE id=? AND (totp_enabled_at IS NULL OR ?=1) AND totp_pending_expires_at>? AND totp_pending_attempts<5")
    .bind(now, matchedCounter, user.id, user.mfaVerified ? 1 : 0, now).run();
  if ((activation.meta.changes ?? 0) !== 1) return c.json({ error: "totp_enrollment_unavailable" }, 409);
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare("DELETE FROM auth_backup_codes WHERE user_id=?").bind(user.id),
    c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,action,resource_type,resource_id) VALUES(?,?,?,'user',?)")
      .bind(crypto.randomUUID(), user.id, row.totp_enabled_at ? "auth.totp_replaced" : "auth.totp_enabled", user.id)
  ];
  for (let i = 0; i < codes.length; i++) statements.push(
    c.env.DB.prepare("INSERT INTO auth_backup_codes(id,user_id,code_hash) VALUES(?,?,?)").bind(crypto.randomUUID(), user.id, hashes[i])
  );
  await c.env.DB.batch(statements);
  const token = getSessionToken(c.req.raw);
  if (!token) return c.json({ error: "session_required" }, 401);
  const tokenHash = base64Url(await digest(token));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM auth_sessions WHERE user_id=? AND token_hash<>?").bind(user.id, tokenHash),
    c.env.DB.prepare("UPDATE auth_sessions SET mfa_verified=1 WHERE token_hash=? AND user_id=?").bind(tokenHash, user.id)
  ]);
  return c.json({ enabled: true, backup_codes: codes });
});

security.post("/totp/disable", async (c) => {
  const user = c.get("user");
  if (user.isSuperadmin) return c.json({ error: "superadmin_mfa_required", message: "La verificación en dos pasos del superadministrador no se puede desactivar." }, 403);
  const body = await c.req.json<{ current_password?: string; code?: string }>().catch(() => ({} as any));
  if (typeof body.current_password !== "string" || body.current_password.length > 256 || typeof body.code !== "string" || body.code.length > 32) return c.json({ error: "invalid_credentials" }, 400);
  const row = await c.env.DB.prepare("SELECT password_hash,password_salt,totp_secret_ciphertext,totp_enabled_at,totp_last_counter FROM users WHERE id=? AND status='active'")
    .bind(user.id).first<{ password_hash: string | null; password_salt: string | null; totp_secret_ciphertext: string | null; totp_enabled_at: string | null; totp_last_counter: number | null }>();
  if (!row?.totp_enabled_at || !row.totp_secret_ciphertext || !row.password_hash || !row.password_salt ||
      !await verifyPassword(body.current_password, row.password_salt, row.password_hash)) {
    return c.json({ error: "invalid_credentials", message: "La contraseña actual no es correcta o la verificación en dos pasos no está activa." }, 401);
  }
  let secret: string;
  try { secret = await decryptTotpSecret(row.totp_secret_ciphertext, c.env.TOTP_ENCRYPTION_KEY); }
  catch { return c.json({ error: "totp_unavailable" }, 503); }
  const matchedCounter = await matchTotpCounter(secret, body.code.trim(), Date.now(), row.totp_last_counter ?? -1);
  if (matchedCounter === null) return c.json({ error: "invalid_totp_code", message: "El código de autenticación no es válido o ya fue utilizado." }, 401);
  const token = getSessionToken(c.req.raw);
  if (!token) return c.json({ error: "session_required" }, 401);
  const tokenHash = base64Url(await digest(token));
  const now = new Date().toISOString();
  const disabled = await c.env.DB.prepare("UPDATE users SET totp_secret_ciphertext=NULL,totp_enabled_at=NULL,totp_last_counter=NULL,totp_pending_secret_ciphertext=NULL,totp_pending_expires_at=NULL,totp_pending_attempts=0 WHERE id=? AND totp_enabled_at IS NOT NULL")
    .bind(user.id).run();
  if ((disabled.meta.changes ?? 0) !== 1) return c.json({ error: "totp_not_enabled" }, 409);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM auth_backup_codes WHERE user_id=?").bind(user.id),
    c.env.DB.prepare("DELETE FROM auth_mfa_challenges WHERE user_id=?").bind(user.id),
    c.env.DB.prepare("DELETE FROM auth_sessions WHERE user_id=? AND token_hash<>?").bind(user.id, tokenHash),
    c.env.DB.prepare("UPDATE auth_sessions SET mfa_verified=0 WHERE user_id=? AND token_hash=?").bind(user.id, tokenHash),
    c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,action,resource_type,resource_id,metadata_json) VALUES(?,?,'auth.totp_disabled','user',?,?)")
      .bind(crypto.randomUUID(), user.id, user.id, JSON.stringify({ disabled_at: now }))
  ]);
  return c.json({ enabled: false, other_sessions_revoked: true });
});

security.get("/totp/status", async (c) => {
  const row = await c.env.DB.prepare("SELECT totp_enabled_at FROM users WHERE id=?").bind(c.get("user").id)
    .first<{ totp_enabled_at: string | null }>();
  const count = await c.env.DB.prepare("SELECT COUNT(*) total FROM auth_backup_codes WHERE user_id=? AND used_at IS NULL")
    .bind(c.get("user").id).first<{ total: number }>();
  return c.json({ enabled: Boolean(row?.totp_enabled_at), unused_backup_codes: count?.total ?? 0 });
});

export { security as securityRoutes };
