import { Hono } from "hono";
import type { Env, AppVariables } from "../types";
import { hashPassword } from "../middleware/auth";

const admin = new Hono<{ Bindings: Env; Variables: AppVariables }>();
admin.use("*", async (c, next) => {
  if (!c.get("user").isSuperadmin) return c.json({ error: "forbidden" }, 403);
  await next();
});

admin.get("/overview", async (c) => {
  const db = c.env.DB;
  const [companies, domains, accounts, users, aliases, storage] = await Promise.all([
    db.prepare("SELECT COUNT(*) total FROM companies").first(),
    db.prepare("SELECT COUNT(*) total FROM domains").first(),
    db.prepare("SELECT COUNT(*) total FROM email_accounts").first(),
    db.prepare(`SELECT COUNT(*) total FROM users u WHERE NOT EXISTS (
      SELECT 1 FROM email_accounts ea JOIN domains d ON d.id=ea.domain_id
      WHERE u.email=(ea.local_part || '@' || d.domain) COLLATE NOCASE
    )`).first(),
    db.prepare("SELECT COUNT(*) total FROM email_aliases").first(),
    db.prepare("SELECT COALESCE(SUM(size_bytes),0) used_bytes FROM mail_storage_reservations WHERE status='committed' OR (status='reserved' AND expires_at>?)").bind(new Date().toISOString()).first<{used_bytes:number}>()
  ]);
  return c.json({ companies: companies?.total ?? 0, domains: domains?.total ?? 0,
    accounts: accounts?.total ?? 0, users: users?.total ?? 0, aliases: aliases?.total ?? 0,
    storage_used_mb: Math.round(((storage?.used_bytes ?? 0) / 1048576) * 10) / 10, storage_limit_mb: 600 });
});
admin.get("/companies", async (c) => {
  const r = await c.env.DB.prepare(`SELECT co.id,co.name,co.slug,co.status,co.created_at,
    (SELECT COUNT(*) FROM domains d WHERE d.company_id=co.id) domain_count,
    (SELECT COUNT(*) FROM email_accounts ea WHERE ea.company_id=co.id) account_count,
    (SELECT COUNT(*) FROM company_memberships cm WHERE cm.company_id=co.id) member_count
    FROM companies co ORDER BY co.created_at DESC LIMIT 200`).all();
  return c.json({ companies: r.results });
});
admin.get("/domains", async (c) => {
  const r = await c.env.DB.prepare(`SELECT d.id,d.company_id,co.name company_name,d.domain,d.status,
    d.inbound_verified_at,d.outbound_verified_at,d.inbound_dns_checked_at,d.resend_domain_id,d.resend_status,d.created_at FROM domains d
    JOIN companies co ON co.id=d.company_id ORDER BY co.name,d.domain LIMIT 300`).all();
  return c.json({ domains: r.results });
});
admin.get("/users", async (c) => {
  const r = await c.env.DB.prepare(`SELECT u.id,u.email,u.display_name,u.status,u.is_superadmin,u.created_at,u.last_login_at,
    (SELECT COUNT(*) FROM company_memberships cm WHERE cm.user_id=u.id) company_count,
    (SELECT group_concat(cm.company_id, ',') FROM company_memberships cm WHERE cm.user_id=u.id) company_ids_csv,
    (SELECT COUNT(*) FROM account_permissions ap WHERE ap.user_id=u.id) account_count
    FROM users u WHERE NOT EXISTS (
      SELECT 1 FROM email_accounts ea JOIN domains d ON d.id=ea.domain_id
      WHERE u.email=(ea.local_part || '@' || d.domain) COLLATE NOCASE
    ) ORDER BY u.created_at DESC LIMIT 300`).all();
  return c.json({ users: r.results });
});

const validAdminEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validAdminPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 12 && value.length <= 256;
}
async function validateCompanyIds(db: D1Database, values: unknown): Promise<string[] | null> {
  if (!Array.isArray(values) || values.length > 50 || values.some((v) => typeof v !== "string")) return null;
  const ids = [...new Set(values.map((v) => (v as string).trim()).filter(Boolean))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const found = await db.prepare(`SELECT id FROM companies WHERE status='active' AND id IN (${placeholders})`)
    .bind(...ids).all<{id:string}>();
  return found.results.length === ids.length ? ids : null;
}
admin.post("/users", async (c) => {
  const body = await c.req.json<{email?:string;display_name?:string;password?:string;company_ids?:unknown}>().catch(() => ({} as any));
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
  if (!validAdminEmail.test(email) || email.length > 254 || !displayName || displayName.length > 120 || !validAdminPassword(body.password))
    return c.json({error:"invalid_user_data",message:"Revisa el correo, nombre y contraseña (mínimo 12 caracteres)."},400);
  const companyIds = await validateCompanyIds(c.env.DB, body.company_ids);
  if (companyIds === null) return c.json({error:"invalid_companies",message:"Una o más empresas no existen o no están activas."},400);
  const credentials = await hashPassword(body.password);
  const id = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare("INSERT INTO users(id,email,display_name,password_hash,password_salt,status,is_superadmin) VALUES(?,?,?,?,?,'active',0)")
      .bind(id,email,displayName,credentials.hash,credentials.salt)
  ];
  for (const companyId of companyIds) {
    statements.push(c.env.DB.prepare("INSERT INTO company_memberships(user_id,company_id,role) VALUES(?,?,'member')").bind(id,companyId));
  }
  statements.push(c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,action,resource_type,resource_id,metadata_json) VALUES(?,?,'user.created','user',?,?)")
    .bind(crypto.randomUUID(),c.get("user").id,id,JSON.stringify({email,company_ids:companyIds})));
  try { await c.env.DB.batch(statements); }
  catch { return c.json({error:"user_creation_conflict",message:"No se pudo crear el usuario. Comprueba que el correo no esté registrado."},409); }
  return c.json({user:{id,email,display_name:displayName,status:"active",is_superadmin:0,company_ids:companyIds}},201);
});
admin.get("/users/:id", async (c) => {
  const id=c.req.param("id");
  const user=await c.env.DB.prepare("SELECT id,email,display_name,status,is_superadmin FROM users WHERE id=?").bind(id).first<any>();
  if(!user)return c.json({error:"user_not_found"},404);
  const memberships=await c.env.DB.prepare("SELECT company_id FROM company_memberships WHERE user_id=? ORDER BY company_id").bind(id).all<{company_id:string}>();
  return c.json({user,company_ids:memberships.results.map(x=>x.company_id)});
});
admin.put("/users/:id", async (c) => {
  const id=c.req.param("id");
  if(id===c.get("user").id)return c.json({error:"cannot_edit_current_admin",message:"No puedes editar tu propia cuenta desde esta sección."},409);
  const target=await c.env.DB.prepare("SELECT id,is_superadmin FROM users WHERE id=?").bind(id).first<{id:string;is_superadmin:number}>();
  if(!target)return c.json({error:"user_not_found"},404);
  if(target.is_superadmin===1)return c.json({error:"superadmin_protected"},409);
  const body=await c.req.json<{email?:string;display_name?:string;company_ids?:unknown}>().catch(()=>({} as any));
  const email=typeof body.email==="string"?body.email.trim().toLowerCase():"";
  const displayName=typeof body.display_name==="string"?body.display_name.trim():"";
  if(!validAdminEmail.test(email)||email.length>254||!displayName||displayName.length>120)
    return c.json({error:"invalid_user_data",message:"Correo o nombre no válidos."},400);
  const companyIds=await validateCompanyIds(c.env.DB,body.company_ids);
  if(companyIds===null)return c.json({error:"invalid_companies",message:"Una o más empresas no existen o no están activas."},400);
  const statements:D1PreparedStatement[]=[
    c.env.DB.prepare("UPDATE users SET email=?,display_name=? WHERE id=?").bind(email,displayName,id),
    c.env.DB.prepare("DELETE FROM company_memberships WHERE user_id=?").bind(id),
    companyIds.length
      ? c.env.DB.prepare(`DELETE FROM account_permissions WHERE user_id=? AND account_id IN (SELECT id FROM email_accounts WHERE company_id NOT IN (${companyIds.map(()=>"?").join(",")}))`).bind(id,...companyIds)
      : c.env.DB.prepare("DELETE FROM account_permissions WHERE user_id=?").bind(id)
  ];
  for(const companyId of companyIds)statements.push(c.env.DB.prepare("INSERT INTO company_memberships(user_id,company_id,role) VALUES(?,?,'member')").bind(id,companyId));
  statements.push(c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,action,resource_type,resource_id,metadata_json) VALUES(?,?,'user.updated','user',?,?)")
    .bind(crypto.randomUUID(),c.get("user").id,id,JSON.stringify({email,company_ids:companyIds})));
  try{await c.env.DB.batch(statements);}catch{return c.json({error:"user_update_conflict",message:"No se pudo guardar. Comprueba que el correo no esté duplicado."},409);}
  return c.json({id,email,display_name:displayName,company_ids:companyIds});
});
admin.post("/users/:id/password", async (c) => {
  const id=c.req.param("id");
  const target=await c.env.DB.prepare("SELECT id,is_superadmin FROM users WHERE id=?").bind(id).first<{id:string;is_superadmin:number}>();
  if(!target)return c.json({error:"user_not_found"},404);
  if(target.is_superadmin===1)return c.json({error:"superadmin_password_protected",message:"La contraseña del superadministrador se gestiona por separado."},409);
  const body=await c.req.json<{password?:string}>().catch(()=>({} as any));
  if(!validAdminPassword(body.password))return c.json({error:"invalid_password",message:"La contraseña debe tener entre 12 y 256 caracteres."},400);
  const credentials=await hashPassword(body.password);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash=?,password_salt=? WHERE id=?").bind(credentials.hash,credentials.salt,id),
    c.env.DB.prepare("DELETE FROM auth_sessions WHERE user_id=?").bind(id),
    c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,action,resource_type,resource_id) VALUES(?,?,'user.password_reset','user',?)").bind(crypto.randomUUID(),c.get("user").id,id)
  ]);
  return c.json({id,password_updated:true,sessions_revoked:true});
});

admin.get("/accounts", async (c) => {
  const r = await c.env.DB.prepare(`SELECT ea.id,ea.company_id,co.name company_name,ea.domain_id,d.domain,
    ea.local_part,ea.local_part || '@' || d.domain AS login_email,ea.display_name,ea.status,ea.created_at,
    (SELECT COUNT(*) FROM account_permissions ap WHERE ap.account_id=ea.id) assigned_user_count,
    COALESCE((SELECT u.status FROM users u WHERE u.email=(ea.local_part || '@' || d.domain) COLLATE NOCASE LIMIT 1),'sin credencial') login_status,
    COALESCE((SELECT group_concat(h.hostname, ', ') FROM company_access_hosts h WHERE h.company_id=ea.company_id AND h.status='active'),'Sin hostname asignado') login_hostnames
    FROM email_accounts ea JOIN companies co ON co.id=ea.company_id JOIN domains d ON d.id=ea.domain_id
    ORDER BY co.name,d.domain,ea.local_part LIMIT 500`).all();
  return c.json({ accounts: r.results });
});
admin.get("/aliases", async (c) => {
  const r = await c.env.DB.prepare(`SELECT al.id,co.name company_name,d.domain,al.local_part,
    target.local_part target_local_part,al.status,al.created_at FROM email_aliases al
    JOIN companies co ON co.id=al.company_id JOIN domains d ON d.id=al.domain_id
    JOIN email_accounts target ON target.id=al.target_account_id
    ORDER BY co.name,d.domain,al.local_part LIMIT 500`).all();
  return c.json({ aliases: r.results });
});
admin.get("/audit", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") || 50),1),200);
  const r = await c.env.DB.prepare(`SELECT a.id,u.email actor_email,co.name company_name,a.action,
    a.resource_type,a.resource_id,a.metadata_json,a.created_at FROM audit_logs a
    LEFT JOIN users u ON u.id=a.actor_user_id LEFT JOIN companies co ON co.id=a.company_id
    ORDER BY a.created_at DESC LIMIT ?`).bind(limit).all();
  return c.json({ events: r.results });
});
admin.patch("/users/:id/status", async (c) => {
  const id=c.req.param("id"); const body=await c.req.json<{status?:string}>().catch((): { status?: string } => ({}));
  if(body.status!=="active" && body.status!=="suspended") return c.json({error:"invalid_status"},400);
  if(id===c.get("user").id && body.status==="suspended") return c.json({error:"cannot_suspend_self"},409);
  const target=await c.env.DB.prepare("SELECT id,is_superadmin FROM users WHERE id=?").bind(id).first<{id:string,is_superadmin:number}>();
  if(!target) return c.json({error:"user_not_found"},404);
  if(target.is_superadmin===1) return c.json({error:"superadmin_status_protected"},409);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET status=? WHERE id=?").bind(body.status,id),
    c.env.DB.prepare("DELETE FROM auth_sessions WHERE user_id=?").bind(id),
    c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,action,resource_type,resource_id,metadata_json) VALUES(?,?,?,?,?,?)")
      .bind(crypto.randomUUID(),c.get("user").id,body.status==="suspended"?"user.suspended":"user.reactivated","user",id,JSON.stringify({status:body.status}))
  ]);
  return c.json({id,status:body.status});
});

admin.get("/access-hosts", async (c) => {
  const r=await c.env.DB.prepare(`SELECT h.id,h.company_id,co.name company_name,h.hostname,h.status,h.created_at
    FROM company_access_hosts h JOIN companies co ON co.id=h.company_id ORDER BY co.name,h.hostname`).all();
  return c.json({access_hosts:r.results});
});
admin.post("/access-hosts", async (c) => {
  const body=await c.req.json<{company_id?:string;hostname?:string}>().catch((): { company_id?: string; hostname?: string } => ({}));
  const companyId=typeof body.company_id === "string" ? body.company_id.trim() : "";
  const hostname=typeof body.hostname === "string" ? body.hostname.trim().toLowerCase() : "";
  if(!companyId || hostname.length>253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname))
    return c.json({error:"invalid_access_host"},400);
  const company=await c.env.DB.prepare("SELECT id FROM companies WHERE id=? AND status!='suspended'").bind(companyId).first();
  if(!company)return c.json({error:"company_not_found"},404);
  const id=crypto.randomUUID();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO company_access_hosts(id,company_id,hostname) VALUES(?,?,?)").bind(id,companyId,hostname),
      c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,company_id,action,resource_type,resource_id) VALUES(?,?,?,'access_host.created','access_host',?)").bind(crypto.randomUUID(),c.get("user").id,companyId,id)
    ]);
  } catch { return c.json({error:"access_host_conflict"},409); }
  return c.json({access_host:{id,company_id:companyId,hostname,status:"active"}},201);
});
admin.delete("/access-hosts/:id", async (c) => {
  const id=c.req.param("id");
  const row=await c.env.DB.prepare("SELECT id,company_id FROM company_access_hosts WHERE id=?").bind(id).first<{id:string;company_id:string}>();
  if(!row)return c.json({error:"access_host_not_found"},404);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM company_access_hosts WHERE id=?").bind(id),
    c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,company_id,action,resource_type,resource_id) VALUES(?,?,?,'access_host.deleted','access_host',?)").bind(crypto.randomUUID(),c.get("user").id,row.company_id,id)
  ]);
  return c.json({id,deleted:true});
});

export { admin as adminRoutes };
