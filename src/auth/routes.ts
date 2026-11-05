import { consumeMfaRecoveryCode } from "./recovery";
import { Hono } from "hono";
import type { Env, AppVariables } from "../types";
import { createSession, hashPassword, revokeSession, verifyPassword } from "../middleware/auth";
import { decryptTotpSecret, hashBackupCode, matchTotpCounter } from "./totp";

const auth = new Hono<{ Bindings: Env; Variables: AppVariables }>();
auth.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    if (!origin || origin !== new URL(c.req.url).origin) return c.json({ error: "csrf_origin_rejected" }, 403);
  }
  await next();
});
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validPassword(value: unknown): value is string { return typeof value === "string" && value.length >= 12 && value.length <= 256; }
function constantTimeTextEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let mismatch = 0; for (let i=0;i<left.length;i++) mismatch |= left[i]^right[i];
  return mismatch === 0;
}
async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, b => b.toString(16).padStart(2,"0")).join("");
}
function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const i=part.indexOf("="); if(i>=0 && part.slice(0,i).trim()===name) return part.slice(i+1).trim();
  }
  return null;
}
const MFA_COOKIE="__Host-emc_mfa_challenge";

auth.get("/status", async c => {
  const row=await c.env.DB.prepare("SELECT COUNT(*) total FROM users WHERE is_superadmin=1").first<{total:number}>();
  const setupRequired=(row?.total??0)===0;
  return c.json({setup_required:setupRequired,setup_enabled:setupRequired&&Boolean(c.env.BOOTSTRAP_TOKEN)});
});

auth.post("/bootstrap", async c => {
  if(!c.env.BOOTSTRAP_TOKEN || c.env.BOOTSTRAP_TOKEN.length<32) return c.json({error:"bootstrap_not_configured"},503);
  const body=await c.req.json<{setup_token?:string;email?:string;display_name?:string;password?:string}>().catch(()=>({} as any));
  const expectedHash=await sha256Hex(c.env.BOOTSTRAP_TOKEN), suppliedHash=await sha256Hex(typeof body.setup_token==="string"?body.setup_token:"");
  if(!constantTimeTextEqual(suppliedHash,expectedHash)) return c.json({error:"invalid_setup_token"},403);
  const email=typeof body.email==="string"?body.email.trim().toLowerCase():"";
  const displayName=typeof body.display_name==="string"?body.display_name.trim():"";
  if(!emailPattern.test(email)||email.length>254||!displayName||displayName.length>120||!validPassword(body.password))
    return c.json({error:"invalid_bootstrap_data"},400);
  const credentials=await hashPassword(body.password), userId=crypto.randomUUID();
  try {
    const result=await c.env.DB.prepare(
      `INSERT INTO users(id,email,display_name,is_superadmin,password_hash,password_salt)
       SELECT ?,?,?,1,?,? WHERE NOT EXISTS(SELECT 1 FROM users WHERE is_superadmin=1)`
    ).bind(userId,email,displayName,credentials.hash,credentials.salt).run();
    if((result.meta.changes??0)!==1)return c.json({error:"bootstrap_already_completed"},409);
    await c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,action,resource_type,resource_id) VALUES(?,?,'auth.superadmin_bootstrapped','user',?)")
      .bind(crypto.randomUUID(),userId,userId).run();
    await createSession(c,userId,false);
    c.header("Set-Cookie",MFA_COOKIE+"=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict",{append:true});
    return c.json({user:{id:userId,email,displayName,isSuperadmin:true,mfaEnabled:false}},201);
  } catch { return c.json({error:"bootstrap_failed"},500); }
});

auth.post("/login", async c => {
  const body=await c.req.json<{email?:string;password?:string}>().catch(()=>({} as any));
  const email=typeof body.email==="string"?body.email.trim().toLowerCase():"", password=typeof body.password==="string"?body.password:"";
  if(!emailPattern.test(email)||email.length>254||!password||password.length>256)return c.json({error:"invalid_credentials"},401);
  const ipHash=await sha256Hex(c.req.header("cf-connecting-ip")||"unknown"), now=new Date();
  const attempt=await c.env.DB.prepare("SELECT failed_count,window_started_at,locked_until FROM auth_login_attempts WHERE ip_hash=? AND email=?")
    .bind(ipHash,email).first<{failed_count:number;window_started_at:string;locked_until:string|null}>();
  if(attempt?.locked_until&&Date.parse(attempt.locked_until)>now.getTime())return c.json({error:"login_temporarily_locked"},429);
  const user=await c.env.DB.prepare(
    "SELECT id,email,display_name,is_superadmin,password_hash,password_salt,totp_secret_ciphertext,totp_enabled_at FROM users WHERE email=? COLLATE NOCASE AND status='active' LIMIT 1"
  ).bind(email).first<{id:string;email:string;display_name:string;is_superadmin:number;password_hash:string|null;password_salt:string|null;totp_secret_ciphertext:string|null;totp_enabled_at:string|null}>();
  const valid=user?.password_hash&&user.password_salt?await verifyPassword(password,user.password_salt,user.password_hash):
    await verifyPassword(password,"AAAAAAAAAAAAAAAAAAAAAA","AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  if(!valid||!user){
    const within=Boolean(attempt&&now.getTime()-Date.parse(attempt.window_started_at)<900000), count=within?(attempt?.failed_count??0)+1:1;
    const locked=count>=8?new Date(now.getTime()+900000).toISOString():null;
    await c.env.DB.prepare(`INSERT INTO auth_login_attempts(ip_hash,email,failed_count,window_started_at,locked_until) VALUES(?,?,?,?,?)
      ON CONFLICT(ip_hash,email) DO UPDATE SET failed_count=excluded.failed_count,window_started_at=excluded.window_started_at,locked_until=excluded.locked_until`)
      .bind(ipHash,email,count,within?attempt!.window_started_at:now.toISOString(),locked).run();
    return c.json({error:"invalid_credentials",message:"Correo o contraseña incorrectos."},401);
  }
  // A normal mailbox user may authenticate only through a hostname
  // explicitly assigned to one of their active companies. Superadmins remain global.
  if (user.is_superadmin !== 1) {
    const hostname = new URL(c.req.url).hostname.toLowerCase();
    const hostAccess = await c.env.DB.prepare(
      `SELECT h.company_id FROM company_access_hosts h
       JOIN companies co ON co.id = h.company_id AND co.status = 'active'
       JOIN company_memberships cm ON cm.company_id = h.company_id AND cm.user_id = ?
       WHERE h.hostname = ? COLLATE NOCASE AND h.status = 'active' LIMIT 1`
    ).bind(user.id, hostname).first<{ company_id: string }>();
    if (!hostAccess) return c.json({error:"invalid_credentials",message:"Correo o contraseña incorrectos."},401);
  }
  await c.env.DB.prepare("DELETE FROM auth_login_attempts WHERE ip_hash=? AND email=?").bind(ipHash,email).run();
  await c.env.DB.prepare("UPDATE users SET last_login_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind(user.id).run();
  if(user.totp_enabled_at && user.totp_secret_ciphertext){
    const token=base64Token(), tokenHash=await sha256Hex(token), id=crypto.randomUUID();
    await c.env.DB.prepare("DELETE FROM auth_mfa_challenges WHERE user_id=? OR expires_at<=?")
      .bind(user.id,now.toISOString()).run();
    await c.env.DB.prepare("INSERT INTO auth_mfa_challenges(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)")
      .bind(id,user.id,tokenHash,new Date(now.getTime()+5*60*1000).toISOString()).run();
    c.header("Set-Cookie",MFA_COOKIE+"="+token+"; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Strict");
    return c.json({mfa_required:true});
  }
  await createSession(c,user.id,false);
  c.header("Set-Cookie",MFA_COOKIE+"=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict",{append:true});
  return c.json({user:{id:user.id,email:user.email,displayName:user.display_name,isSuperadmin:user.is_superadmin===1,mfaEnabled:Boolean(user.totp_enabled_at)}});
});
function base64Token(){return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");}

auth.post("/mfa/verify", async c => {
  const token=cookie(c.req.raw,MFA_COOKIE);
  if(!token||!/^[A-Za-z0-9_-]{40,64}$/.test(token))return c.json({error:"mfa_challenge_expired"},401);
  const tokenHash=await sha256Hex(token);
  const challenge=await c.env.DB.prepare(
    `SELECT ch.id,ch.user_id,ch.expires_at,ch.attempts,u.email,u.display_name,u.totp_secret_ciphertext,u.totp_last_counter
     FROM auth_mfa_challenges ch JOIN users u ON u.id=ch.user_id
     WHERE ch.token_hash=? AND ch.expires_at>? AND u.status='active' AND u.totp_enabled_at IS NOT NULL LIMIT 1`
  ).bind(tokenHash,new Date().toISOString()).first<{id:string;user_id:string;expires_at:string;attempts:number;email:string;display_name:string;totp_secret_ciphertext:string|null;totp_last_counter:number|null}>();
  if(!challenge||challenge.attempts>=5)return c.json({error:"mfa_challenge_expired"},401);
  const body=await c.req.json<{code?:string}>().catch(()=>({} as any)), code=typeof body.code==="string"?body.code.trim():"";
  let valid=false;
  let usedBackupCode=false;
  let challengeConsumed=false;
  if(/^\d{6}$/.test(code)){
    try {
      const secret=await decryptTotpSecret(challenge.totp_secret_ciphertext||"",c.env.TOTP_ENCRYPTION_KEY);
      const matchedCounter=await matchTotpCounter(secret,code,Date.now(),challenge.totp_last_counter??-1);
      if(matchedCounter!==null){
        const updated=await c.env.DB.prepare("UPDATE users SET totp_last_counter=? WHERE id=? AND (totp_last_counter IS NULL OR totp_last_counter<?)")
          .bind(matchedCounter,challenge.user_id,matchedCounter).run();
        valid=(updated.meta.changes??0)===1;
      }
    } catch { return c.json({error:"mfa_unavailable"},503); }
  } else if(/^[A-Fa-f0-9]{16}$/.test(code.replace(/[-\s]/g,""))){
    const backupHash=await hashBackupCode(code);
    const now=new Date().toISOString();
    valid=await consumeMfaRecoveryCode(c.env.DB,{
      userId:challenge.user_id,codeHash:backupHash,
      challengeId:challenge.id,tokenHash,now
    });
    challengeConsumed=valid;
    usedBackupCode=valid;
  }
  if(!valid){
    await c.env.DB.prepare("UPDATE auth_mfa_challenges SET attempts=attempts+1 WHERE id=? AND attempts<5").bind(challenge.id).run();
    return c.json({error:"invalid_mfa_code"},401);
  }
  if(!challengeConsumed){
    const consumed=await c.env.DB.prepare("DELETE FROM auth_mfa_challenges WHERE id=? AND token_hash=? AND expires_at>?")
      .bind(challenge.id,tokenHash,new Date().toISOString()).run();
    if((consumed.meta.changes??0)!==1)return c.json({error:"mfa_challenge_expired"},401);
  }
  c.header("Set-Cookie",MFA_COOKIE+"=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict");
  await createSession(c,challenge.user_id,true);
  if(usedBackupCode)await c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,action,resource_type,resource_id) VALUES(?,?,'auth.backup_code_used','user',?)")
    .bind(crypto.randomUUID(),challenge.user_id,challenge.user_id).run();
  await c.env.DB.prepare("UPDATE users SET last_login_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind(challenge.user_id).run();
  return c.json({user:{id:challenge.user_id,email:challenge.email,displayName:challenge.display_name,isSuperadmin:true,mfaEnabled:true}});
});

auth.post("/logout",async c=>{await revokeSession(c);c.header("Set-Cookie",MFA_COOKIE+"=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict",{append:true});return c.json({ok:true});});
export {auth as authRoutes};
