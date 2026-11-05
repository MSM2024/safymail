import { isValidResendWebhookSecret } from "./webhook-secret-validation";
import { Hono } from "hono";
import { sealCredentials, openCredentials, processProvisioningJob, deriveMaintenanceToken, deriveResendRelayToken, openProvisioningSecret, sealSecret } from "./provisioning-jobs";
import { processMaintenanceBatch } from "./maintenance-jobs";
import { verifyResendWebhook } from "../../src/email/webhooks";

interface Env {
  CONTROL_DB: D1Database;
  CONTROL_PLANE_ADMIN_TOKEN_HASH: string;
  CONTROL_PLANE_VAULT_KEY: string;
  CONTROL_PLANE_ENV?: string;
  CONTROL_PLANE_PUBLIC_URL?: string;
  PROVISIONING_QUEUE: Queue<{ installationId: string; jobId: string } | { type: "maintenance"; installationIds: string[]; slot: string }>;
}
type Vars = { requestId: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
const id = () => crypto.randomUUID();
const enc = new TextEncoder();

function fail(c: any, status: number, error: string) {
  return c.json({ error, request_id: c.get("requestId") }, status);
}
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return Array.from(new Uint8Array(bytes)).map(x => x.toString(16).padStart(2, "0")).join("");
}
async function audit(db: D1Database, installationId: string | null, action: string, outcome: "success" | "failure", metadata: Record<string, unknown> = {}) {
  await db.prepare("INSERT INTO control_audit_logs (id,installation_id,action,outcome,metadata_json) VALUES (?,?,?,?,?)")
    .bind(id(), installationId, action, outcome, JSON.stringify(metadata)).run();
}

app.use("*", async (c, next) => {
  c.set("requestId", id());
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  await next();
});
app.get("/health", c => c.json({ status: "ok", service: "mail-center-control-plane", environment: c.env.CONTROL_PLANE_ENV || "unknown" }));
app.use("/api/*", async (c, next) => {
  const header = c.req.header("Authorization") || "";
  const match = /^Bearer ([A-Za-z0-9._~-]{32,512})$/.exec(header);
  if (!match || !c.env.CONTROL_PLANE_ADMIN_TOKEN_HASH) return fail(c, 401, "unauthorized");
  if (!equal(await sha256(match[1]), c.env.CONTROL_PLANE_ADMIN_TOKEN_HASH.toLowerCase())) return fail(c, 401, "unauthorized");
  if (!c.env.CONTROL_PLANE_VAULT_KEY || c.env.CONTROL_PLANE_VAULT_KEY.length < 32) return fail(c, 503, "vault_not_configured");
  await next();
});

app.post("/api/provider-accounts", async c => {
  const rawBody = await c.req.text();
  if (enc.encode(rawBody).byteLength > 32768) return fail(c, 413, "payload_too_large");
  let body: any;
  try { body = JSON.parse(rawBody); } catch { return fail(c, 400, "invalid_json"); }
  const cfToken = body?.credentials?.cloudflareApiToken;
  const cfAccount = body?.credentials?.cloudflareAccountId;
  const resendKey = body?.credentials?.resendApiKey;
  if (typeof cfToken !== "string" || cfToken.length < 20 ||
      typeof cfAccount !== "string" || !/^[a-f0-9]{32}$/i.test(cfAccount) ||
      typeof resendKey !== "string" || resendKey.length < 20) {
    return fail(c, 400, "provider_credentials_required");
  }

  const accountId = cfAccount.toLowerCase();
  const existing = await c.env.CONTROL_DB.prepare(
    "SELECT id,status,credentials_ciphertext,credentials_nonce FROM control_provider_accounts WHERE cloudflare_account_id=?"
  ).bind(accountId).first<{ id: string; status: string; credentials_ciphertext: string; credentials_nonce: string }>();
  if (existing?.status === "revoked") return fail(c, 409, "provider_account_revoked");
  if (existing) {
    const [active, linked] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        "SELECT COUNT(*) AS jobs FROM control_installations WHERE provider_account_id=? AND status='provisioning'"
      ).bind(existing.id).first<{ jobs: number }>(),
      c.env.CONTROL_DB.prepare(
        "SELECT COUNT(*) AS domains FROM control_installations WHERE provider_account_id=?"
      ).bind(existing.id).first<{ domains: number }>()
    ]);
    if ((active?.jobs || 0) > 0) return fail(c, 409, "provider_account_in_use");
    if ((linked?.domains || 0) > 0) {
      const previous = await openCredentials(
        c.env.CONTROL_PLANE_VAULT_KEY, existing.credentials_ciphertext, existing.credentials_nonce,
        "provider-account:" + existing.id
      );
      if (previous.resendApiKey !== resendKey) return fail(c, 409, "resend_key_rotation_requires_reconciliation");
    }
  }
  const providerAccountId = existing?.id || id();
  let controlPlaneOrigin: string;
  try {
    const configured = new URL(c.env.CONTROL_PLANE_PUBLIC_URL || "");
    if (configured.protocol !== "https:" || configured.username || configured.password ||
        configured.pathname !== "/" || configured.search || configured.hash) throw new Error("invalid");
    controlPlaneOrigin = configured.origin;
  } catch {
    return fail(c, 503, "control_plane_public_url_not_configured");
  }
  const webhookEndpoint = controlPlaneOrigin + "/webhooks/resend/" + providerAccountId;
  const sealed = await sealCredentials(c.env.CONTROL_PLANE_VAULT_KEY, {
    cloudflareApiToken: cfToken, cloudflareAccountId: accountId, resendApiKey: resendKey
  }, "provider-account:" + providerAccountId);
  if (existing) {
    await c.env.CONTROL_DB.prepare(
      "UPDATE control_provider_accounts SET credentials_ciphertext=?,credentials_nonce=?,webhook_endpoint=?,status='active',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?"
    ).bind(sealed.ciphertext, sealed.nonce, webhookEndpoint, providerAccountId).run();
  } else {
    await c.env.CONTROL_DB.prepare(
      "INSERT INTO control_provider_accounts (id,cloudflare_account_id,credentials_ciphertext,credentials_nonce,webhook_endpoint) VALUES (?,?,?,?,?)"
    ).bind(providerAccountId, accountId, sealed.ciphertext, sealed.nonce, webhookEndpoint).run();
  }
  const usage = await c.env.CONTROL_DB.prepare(
    "SELECT COUNT(*) AS domains FROM control_installations WHERE provider_account_id=?"
  ).bind(providerAccountId).first<{ domains: number }>();
  await audit(c.env.CONTROL_DB, null, "provider_account.authorized", "success", {
    providerAccountId, cloudflareAccountId: accountId, managedDomains: usage?.domains || 0
  });
  return c.json({
    providerAccountId, cloudflareAccountId: accountId, webhookEndpoint,
    managedDomains: usage?.domains || 0, maxDomains: 2, status: "active"
  }, existing ? 200 : 201);
});

app.get("/api/provider-accounts", async c => {
  const rows = await c.env.CONTROL_DB.prepare(
    "SELECT a.id,a.cloudflare_account_id,a.status,a.created_at,a.updated_at,COUNT(i.id) AS managed_domains FROM control_provider_accounts a LEFT JOIN control_installations i ON i.provider_account_id=a.id GROUP BY a.id ORDER BY a.created_at DESC"
  ).all();
  return c.json({ providerAccounts: rows.results || [], maxDomainsPerAccount: 2 });
});

app.post("/api/installations/:id/provider-account", async c => {
  const installationId = c.req.param("id");
  const body = await c.req.json().catch(() => null) as any;
  const providerAccountId = typeof body?.providerAccountId === "string" ? body.providerAccountId : "";
  if (!/^[a-f0-9-]{16,64}$/i.test(providerAccountId)) return fail(c, 400, "invalid_provider_account_id");
  const [installation, account] = await Promise.all([
    c.env.CONTROL_DB.prepare("SELECT id,status,provider_account_id FROM control_installations WHERE id=?")
      .bind(installationId).first<any>(),
    c.env.CONTROL_DB.prepare("SELECT id,cloudflare_account_id,status FROM control_provider_accounts WHERE id=?")
      .bind(providerAccountId).first<any>()
  ]);
  if (!installation) return fail(c, 404, "installation_not_found");
  if (!account || account.status !== "active") return fail(c, 404, "provider_account_not_found");
  if (installation.status === "provisioning" || installation.status === "ready") return fail(c, 409, "installation_provider_locked");
  if (installation.provider_account_id && installation.provider_account_id !== providerAccountId) return fail(c, 409, "provider_account_already_assigned");
  const count = await c.env.CONTROL_DB.prepare(
    "SELECT COUNT(*) AS domains FROM control_installations WHERE provider_account_id=?"
  ).bind(providerAccountId).first<{ domains: number }>();
  if (!installation.provider_account_id && (count?.domains || 0) >= 2) return fail(c, 409, "provider_account_domain_limit_reached");
  try {
    await c.env.CONTROL_DB.prepare(
      "UPDATE control_installations SET provider_account_id=?,cloudflare_account_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?"
    ).bind(providerAccountId, account.cloudflare_account_id, installationId).run();
  } catch (error: any) {
    if (String(error?.message || "").includes("provider_account_domain_limit_reached")) return fail(c, 409, "provider_account_domain_limit_reached");
    throw error;
  }
  await audit(c.env.CONTROL_DB, installationId, "provider_account.attached", "success", { providerAccountId });
  return c.json({ installationId, providerAccountId, cloudflareAccountId: account.cloudflare_account_id, managedDomains: (count?.domains || 0) + (installation.provider_account_id ? 0 : 1), maxDomains: 2 });
});

app.post("/api/installations", async c => {
  const rawBody = await c.req.text();
  if (enc.encode(rawBody).byteLength > 16384) return fail(c, 413, "payload_too_large");
  let body: any;
  try { body = JSON.parse(rawBody); } catch { return fail(c, 400, "invalid_json"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(c, 400, "invalid_payload");
  const domain = typeof body.domain === "string" ? body.domain.trim().toLowerCase() : "";
  const adminEmail = typeof body.adminEmail === "string" ? body.adminEmail.trim().toLowerCase() : "";
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return fail(c, 400, "invalid_domain");
  if (!/^[^\s@]{1,64}@[a-z0-9.-]+\.[a-z]{2,63}$/.test(adminEmail)) return fail(c, 400, "invalid_admin_email");
  const requestKey = c.req.header("Idempotency-Key") || null;
  if (requestKey && !/^[A-Za-z0-9._:-]{8,128}$/.test(requestKey)) return fail(c, 400, "invalid_idempotency_key");
  if (requestKey) {
    const previous = await c.env.CONTROL_DB.prepare("SELECT id,app_name,worker_name,domain,admin_email,resend_region,status FROM control_installations WHERE idempotency_key=?")
      .bind(requestKey).first<any>();
    if (previous) return c.json({ id: previous.id, appName: previous.app_name, workerName: previous.worker_name, domain: previous.domain, adminEmail: previous.admin_email, resendRegion: previous.resend_region, status: previous.status, reused: true });
  }
  const installationId = id();
  const labels = domain.split(".");
  const inferredName = labels[labels.length > 2 ? labels.length - 2 : 0].replace(/-/g, " ");
  const appName = typeof body.appName === "string" && body.appName.trim() ? body.appName.trim() : inferredName;
  if (appName.length > 80) return fail(c, 400, "invalid_app_name");
  const requestedWorkerName = typeof body.workerName === "string" ? body.workerName.trim().toLowerCase() : "";
  const baseSlug = (requestedWorkerName || domain.split(".").slice(0, -1).join("-"))
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 52);
  const workerName = requestedWorkerName || (baseSlug + "-" + installationId.slice(0, 6));
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workerName)) return fail(c, 400, "invalid_worker_name");
  try {
    await c.env.CONTROL_DB.prepare("INSERT INTO control_installations (id,app_name,worker_name,domain,admin_email,resend_region,idempotency_key) VALUES (?,?,?,?,?,'eu-west-1',?)")
      .bind(installationId, appName, workerName, domain, adminEmail, requestKey).run();
    await audit(c.env.CONTROL_DB, installationId, "installation.created", "success");
    return c.json({ id: installationId, appName, workerName, domain, adminEmail, resendRegion: "eu-west-1", status: "draft" }, 201);
  } catch (error: any) {
    if (requestKey) {
      const raced = await c.env.CONTROL_DB.prepare("SELECT id,app_name,worker_name,domain,admin_email,resend_region,status FROM control_installations WHERE idempotency_key=?")
        .bind(requestKey).first<any>();
      if (raced) return c.json({ id: raced.id, appName: raced.app_name, workerName: raced.worker_name, domain: raced.domain, adminEmail: raced.admin_email, resendRegion: raced.resend_region, status: raced.status, reused: true });
    }
    if (String(error?.message || "").includes("UNIQUE")) return fail(c, 409, "installation_conflict");
    await audit(c.env.CONTROL_DB, installationId, "installation.created", "failure", { code: "database_error" });
    return fail(c, 500, "installation_create_failed");
  }
});
app.get("/api/installations", async c => {
  const rows = await c.env.CONTROL_DB.prepare("SELECT id,app_name,worker_name,domain,admin_email,resend_region,status,current_step,error_code,provider_account_id,created_at,updated_at FROM control_installations ORDER BY created_at DESC LIMIT 100").all();
  return c.json({ installations: rows.results || [] });
});
app.get("/api/installations/:id", async c => {
  const installationId = c.req.param("id");
  const installation = await c.env.CONTROL_DB.prepare("SELECT id,app_name,worker_name,domain,admin_email,resend_region,status,current_step,error_code,error_message,provider_account_id,created_at,updated_at FROM control_installations WHERE id=?").bind(installationId).first();
  if (!installation) return fail(c, 404, "installation_not_found");
  const checkpoints = await c.env.CONTROL_DB.prepare("SELECT step,status,details_json,idempotency_key,created_at FROM control_checkpoints WHERE installation_id=? ORDER BY created_at").bind(installationId).all();
  const job = await c.env.CONTROL_DB.prepare("SELECT job_id,expires_at,created_at FROM control_provisioning_jobs WHERE installation_id=?").bind(installationId).first();
  return c.json({ installation, checkpoints: checkpoints.results || [], job: job || null });
});

app.post("/api/installations/:id/provision", async c => {
  const installationId = c.req.param("id");
  const rawBody = await c.req.text();
  if (enc.encode(rawBody).byteLength > 32768) return fail(c, 413, "payload_too_large");
  let body: any;
  try { body = JSON.parse(rawBody); } catch { return fail(c, 400, "invalid_json"); }
  const installation = await c.env.CONTROL_DB.prepare(
    "SELECT id,status,current_step,provider_account_id,cloudflare_account_id FROM control_installations WHERE id=?"
  ).bind(installationId).first<any>();
  if (!installation) return fail(c, 404, "installation_not_found");
  if (installation.status === "provisioning" && ["queued", "processing"].includes(installation.current_step || "")) {
    const activeJob = await c.env.CONTROL_DB.prepare(
      "SELECT job_id,expires_at FROM control_provisioning_jobs WHERE installation_id=?"
    ).bind(installationId).first<any>();
    if (activeJob) return c.json({
      installationId, jobId: activeJob.job_id, status: "queued",
      credentialsExpireAt: activeJob.expires_at, reused: true
    }, 202);
    return fail(c, 409, "provisioning_already_running");
  }
  const cfToken = body?.credentials?.cloudflareApiToken;
  const cfAccount = body?.credentials?.cloudflareAccountId;
  const resendKey = body?.credentials?.resendApiKey;
  const hasCredentials = cfToken !== undefined || cfAccount !== undefined || resendKey !== undefined;
  let providerCredentials: { cloudflareApiToken: string; cloudflareAccountId: string; resendApiKey: string };
  let providerAccountId = installation.provider_account_id as string | null;

  if (hasCredentials) {
    if (typeof cfToken !== "string" || cfToken.length < 20 ||
        typeof cfAccount !== "string" || !/^[a-f0-9]{32}$/i.test(cfAccount) ||
        typeof resendKey !== "string" || resendKey.length < 20) {
      return fail(c, 400, "provider_credentials_required");
    }
    const normalizedAccount = cfAccount.toLowerCase();
    if (installation.cloudflare_account_id && String(installation.cloudflare_account_id).toLowerCase() !== normalizedAccount) {
      return fail(c, 409, "cloudflare_account_mismatch");
    }
    const existingAccount = await c.env.CONTROL_DB.prepare(
      "SELECT id,status FROM control_provider_accounts WHERE cloudflare_account_id=?"
    ).bind(normalizedAccount).first<{ id: string; status: string }>();
    if (existingAccount?.status === "revoked") return fail(c, 409, "provider_account_revoked");
    providerAccountId = providerAccountId || existingAccount?.id || id();
    if (existingAccount && existingAccount.id !== providerAccountId) return fail(c, 409, "provider_account_already_assigned");
    const usage = await c.env.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS domains FROM control_installations WHERE provider_account_id=?"
    ).bind(providerAccountId).first<{ domains: number }>();
    if (!installation.provider_account_id && (usage?.domains || 0) >= 2) return fail(c, 409, "provider_account_domain_limit_reached");
    providerCredentials = { cloudflareApiToken: cfToken, cloudflareAccountId: normalizedAccount, resendApiKey: resendKey };
    const persistent = await sealCredentials(c.env.CONTROL_PLANE_VAULT_KEY, providerCredentials, "provider-account:" + providerAccountId);
    if (existingAccount) {
      await c.env.CONTROL_DB.prepare(
        "UPDATE control_provider_accounts SET credentials_ciphertext=?,credentials_nonce=?,status='active',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?"
      ).bind(persistent.ciphertext, persistent.nonce, providerAccountId).run();
    } else {
      await c.env.CONTROL_DB.prepare(
        "INSERT INTO control_provider_accounts (id,cloudflare_account_id,credentials_ciphertext,credentials_nonce) VALUES (?,?,?,?)"
      ).bind(providerAccountId, normalizedAccount, persistent.ciphertext, persistent.nonce).run();
    }
    try {
      await c.env.CONTROL_DB.prepare(
        "UPDATE control_installations SET provider_account_id=?,cloudflare_account_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?"
      ).bind(providerAccountId, normalizedAccount, installationId).run();
    } catch (error: any) {
      if (String(error?.message || "").includes("provider_account_domain_limit_reached")) return fail(c, 409, "provider_account_domain_limit_reached");
      throw error;
    }
  } else {
    if (!providerAccountId) return fail(c, 400, "provider_credentials_or_account_required");
    const account = await c.env.CONTROL_DB.prepare(
      "SELECT cloudflare_account_id,credentials_ciphertext,credentials_nonce,status FROM control_provider_accounts WHERE id=?"
    ).bind(providerAccountId).first<any>();
    if (!account || account.status !== "active") return fail(c, 409, "provider_account_unavailable");
    providerCredentials = await openCredentials(
      c.env.CONTROL_PLANE_VAULT_KEY, account.credentials_ciphertext, account.credentials_nonce,
      "provider-account:" + providerAccountId
    );
    if (installation.cloudflare_account_id && String(installation.cloudflare_account_id).toLowerCase() !== providerCredentials.cloudflareAccountId.toLowerCase()) {
      return fail(c, 409, "cloudflare_account_mismatch");
    }
  }
  const jobId = id();
  const sealed = await sealCredentials(c.env.CONTROL_PLANE_VAULT_KEY, providerCredentials, installationId + ":" + jobId);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  try {
    await c.env.CONTROL_DB.prepare(
      "INSERT INTO control_provisioning_jobs (installation_id,job_id,ciphertext,nonce,expires_at) VALUES (?,?,?,?,?)"
    ).bind(installationId, jobId, sealed.ciphertext, sealed.nonce, expiresAt).run();
    const updated = await c.env.CONTROL_DB.prepare(
      "UPDATE control_installations SET cloudflare_account_id=?,status='provisioning',current_step='queued',provision_lock=NULL,lock_expires_at=NULL,error_code=NULL,error_message=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status IN ('draft','failed','paused')"
    ).bind(providerCredentials.cloudflareAccountId.toLowerCase(), installationId).run();
    if (!updated.meta.changes) {
      await c.env.CONTROL_DB.prepare("DELETE FROM control_provisioning_jobs WHERE installation_id=? AND job_id=?").bind(installationId, jobId).run();
      return fail(c, 409, "installation_not_resumable");
    }
    try {
      await c.env.PROVISIONING_QUEUE.send({ installationId, jobId });
    } catch {
      await c.env.CONTROL_DB.prepare("DELETE FROM control_provisioning_jobs WHERE installation_id=? AND job_id=?").bind(installationId, jobId).run();
      await c.env.CONTROL_DB.prepare(
        "UPDATE control_installations SET status='failed',current_step='queue_publish_failed',error_code='queue_unavailable',error_message='Provisioning queue could not accept the job. Submit the request again.',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='provisioning' AND current_step='queued'"
      ).bind(installationId).run();
      return fail(c, 503, "provisioning_queue_unavailable");
    }
    await audit(c.env.CONTROL_DB, installationId, "provisioning.queued", "success", { jobId, credentialsExpireAt: expiresAt });
    return c.json({ installationId, jobId, status: "queued", credentialsExpireAt: expiresAt }, 202);
  } catch (error: any) {
    if (String(error?.message || "").includes("UNIQUE")) return fail(c, 409, "provisioning_job_conflict");
    return fail(c, 500, "provisioning_enqueue_failed");
  }
});
app.get("/api/installations/:id/dns-requirements", async c => {
  const installationId = c.req.param("id");
  const installation = await c.env.CONTROL_DB.prepare(
    "SELECT id,domain,worker_name,status,cloudflare_account_id FROM control_installations WHERE id=?"
  ).bind(installationId).first<{ id: string; domain: string; worker_name: string; status: string; cloudflare_account_id: string | null }>();
  if (!installation) return fail(c, 404, "installation_not_found");
  if (!["configuring", "waiting_dns", "verifying", "bootstrapping", "ready"].includes(installation.status)) {
    return fail(c, 409, "dns_requirements_not_ready");
  }
  const zone = await c.env.CONTROL_DB.prepare(
    "SELECT details_json FROM control_checkpoints WHERE installation_id=? AND step='cloudflare_verified' AND status='completed' ORDER BY created_at DESC LIMIT 1"
  ).bind(installationId).first<{ details_json: string }>();
  const resend = await c.env.CONTROL_DB.prepare(
    "SELECT details_json FROM control_checkpoints WHERE installation_id=? AND step='resend_domain_ready' AND status='completed' ORDER BY created_at DESC LIMIT 1"
  ).bind(installationId).first<{ details_json: string }>();
  if (!zone || !resend) return fail(c, 409, "dns_requirements_missing");
  let zoneDetails: any, resendDetails: any;
  try { zoneDetails = JSON.parse(zone.details_json); resendDetails = JSON.parse(resend.details_json); } catch {
    return fail(c, 500, "dns_requirements_corrupt");
  }
  if (!/^[a-f0-9]{32}$/i.test(String(zoneDetails.zoneId || "")) || !Array.isArray(resendDetails.records)) {
    return fail(c, 409, "dns_requirements_incomplete");
  }
  await audit(c.env.CONTROL_DB, installationId, "dns.requirements.read", "success");
  return c.json({ domain: installation.domain, workerName: installation.worker_name, accountId: installation.cloudflare_account_id, zoneId: zoneDetails.zoneId, records: resendDetails.records });
});

app.get("/api/installations/:id/deployment-config", async c => {
  const installationId = c.req.param("id");
  const installation = await c.env.CONTROL_DB.prepare(
    "SELECT id,app_name,worker_name,domain,admin_email,resend_region,status,cloudflare_account_id FROM control_installations WHERE id=?"
  ).bind(installationId).first<any>();
  if (!installation) return fail(c, 404, "installation_not_found");
  if (installation.status !== "configuring") return fail(c, 409, "installation_not_ready_for_deployment");
  if (!installation.cloudflare_account_id) return fail(c, 409, "cloudflare_account_not_recorded");

  const checkpoints = await c.env.CONTROL_DB.prepare(
    "SELECT step,details_json FROM control_checkpoints WHERE installation_id=? AND status='completed' ORDER BY created_at"
  ).bind(installationId).all<{ step: string; details_json: string }>();
  const details = new Map<string, any>();
  for (const checkpoint of checkpoints.results || []) {
    try { details.set(checkpoint.step, JSON.parse(checkpoint.details_json)); } catch { /* malformed checkpoint fails below */ }
  }
  const zone = details.get("cloudflare_verified");
  const d1 = details.get("d1_ready");
  const kv = details.get("kv_ready");
  if (!zone?.zoneId || !d1?.id || !d1?.name || !kv?.id) return fail(c, 409, "deployment_resources_incomplete");

  const webhook = await c.env.CONTROL_DB.prepare(
    "SELECT ciphertext,nonce FROM control_secrets WHERE installation_id=? AND secret_name='RESEND_WEBHOOK_SECRET'"
  ).bind(installationId).first<{ ciphertext: string; nonce: string }>();
  if (!webhook) return fail(c, 409, "webhook_secret_missing");
  const webhookSecret = await openProvisioningSecret(c.env.CONTROL_PLANE_VAULT_KEY, webhook.ciphertext, webhook.nonce, installationId + ":RESEND_WEBHOOK_SECRET");
  const maintenanceToken = await deriveMaintenanceToken(c.env.CONTROL_PLANE_VAULT_KEY, installationId);
  const resendRelayToken = await deriveResendRelayToken(c.env.CONTROL_PLANE_VAULT_KEY, installationId);
  await audit(c.env.CONTROL_DB, installationId, "deployment.config.issued", "success");
  return c.json({
    installationId,
    appName: installation.app_name,
    workerName: installation.worker_name,
    domain: installation.domain,
    adminEmail: installation.admin_email,
    resendRegion: installation.resend_region,
    cloudflare: { accountId: installation.cloudflare_account_id, zoneId: zone.zoneId },
    resources: { d1DatabaseName: d1.name, d1DatabaseId: d1.id, kvNamespaceId: kv.id },
    runtimeSecrets: {
      resendWebhookSecret: webhookSecret,
      maintenanceToken,
      resendRelayToken
    }
  });
});

app.get("/api/installations/:id/runtime-config", async c => {
  const installationId = c.req.param("id");
  const installation = await c.env.CONTROL_DB.prepare(
    "SELECT id,domain,worker_name,status,cloudflare_account_id FROM control_installations WHERE id=?"
  ).bind(installationId).first<{ id: string; domain: string; worker_name: string; status: string; cloudflare_account_id: string | null }>();
  if (!installation) return fail(c, 404, "installation_not_found");
  if (!["configuring", "waiting_dns", "verifying", "bootstrapping", "ready"].includes(installation.status)) {
    return fail(c, 409, "installation_not_ready_for_runtime_configuration");
  }
  if (!installation.cloudflare_account_id) return fail(c, 409, "cloudflare_account_not_recorded");
  const token = await deriveMaintenanceToken(c.env.CONTROL_PLANE_VAULT_KEY, installationId);
  const resendRelayToken = await deriveResendRelayToken(c.env.CONTROL_PLANE_VAULT_KEY, installationId);
  await audit(c.env.CONTROL_DB, installationId, "runtime.maintenance_token.issued", "success");
  return c.json({
    workerName: installation.worker_name,
    accountId: installation.cloudflare_account_id,
    maintenance: { url: "https://" + installation.domain + "/api/internal/maintenance", authorization: "Bearer " + token },
    resendRelay: { authorization: "Bearer " + resendRelayToken }
  });
});

// Recover a pre-existing Resend webhook without deleting, recreating, or rotating it.
// Admin API authentication is enforced by the /api/* middleware above.
app.post("/api/installations/:id/resend-webhook-secret", async c => {
  const installationId = c.req.param("id");
  if (!/^[a-f0-9-]{16,64}$/i.test(installationId)) return fail(c, 404, "installation_not_found");
  const raw = await c.req.text();
  if (enc.encode(raw).byteLength > 4096) return fail(c, 413, "payload_too_large");
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return fail(c, 400, "invalid_json"); }
  const secret = (body && typeof body === "object" && "signing_secret" in body)
    ? (body as { signing_secret?: unknown }).signing_secret : undefined;
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/=]{16,512}$/.test(secret) || !isValidResendWebhookSecret(secret)) {
    return fail(c, 400, "invalid_webhook_signing_secret");
  }
  const installation = await c.env.CONTROL_DB.prepare(
    "SELECT id,status,current_step,provider_account_id FROM control_installations WHERE id=?"
  ).bind(installationId).first<{ id: string; status: string; current_step: string; provider_account_id: string | null }>();
  if (!installation) return fail(c, 404, "installation_not_found");
  if (installation.status !== "failed" || installation.current_step !== "resend_domain_ready" || !installation.provider_account_id) {
    return fail(c, 409, "installation_not_eligible_for_webhook_recovery");
  }
  const providerAccountId = installation.provider_account_id;
  const provider = await c.env.CONTROL_DB.prepare(
    "SELECT status,webhook_endpoint FROM control_provider_accounts WHERE id=?"
  ).bind(providerAccountId).first<{ status: string; webhook_endpoint: string | null }>();
  if (!provider || provider.status !== "active" || !provider.webhook_endpoint) return fail(c, 409, "provider_account_not_ready");
  const [existingShared, existingInstallation] = await Promise.all([
    c.env.CONTROL_DB.prepare(
      "SELECT provider_account_id FROM control_provider_secrets WHERE provider_account_id=? AND secret_name='RESEND_WEBHOOK_SECRET'"
    ).bind(providerAccountId).first(),
    c.env.CONTROL_DB.prepare(
      "SELECT installation_id FROM control_secrets WHERE installation_id=? AND secret_name='RESEND_WEBHOOK_SECRET'"
    ).bind(installationId).first()
  ]);
  if (existingShared || existingInstallation) return fail(c, 409, "webhook_secret_already_configured");

  const shared = await sealSecret(c.env.CONTROL_PLANE_VAULT_KEY, secret, providerAccountId + ":RESEND_WEBHOOK_SECRET");
  const scoped = await sealSecret(c.env.CONTROL_PLANE_VAULT_KEY, secret, installationId + ":RESEND_WEBHOOK_SECRET");
  try {
    // Both vault envelopes are written in a single D1 transaction.
    // No secret value is included in the API response or audit record.
    await c.env.CONTROL_DB.batch([
      c.env.CONTROL_DB.prepare(
        "INSERT INTO control_provider_secrets(provider_account_id,secret_name,ciphertext,nonce,algorithm,updated_at) VALUES (?,'RESEND_WEBHOOK_SECRET',?,?,'AES-GCM-256',strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
      ).bind(providerAccountId, shared.ciphertext, shared.nonce),
      c.env.CONTROL_DB.prepare(
        "INSERT INTO control_secrets(installation_id,secret_name,ciphertext,nonce,algorithm,updated_at) VALUES (?,'RESEND_WEBHOOK_SECRET',?,?,'AES-GCM-256',strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
      ).bind(installationId, scoped.ciphertext, scoped.nonce),
      c.env.CONTROL_DB.prepare(
        "INSERT INTO control_audit_logs(id,installation_id,action,outcome,metadata_json) VALUES (?,?,'webhook.secret.recovered','success','{}')"
      ).bind(id(),installationId)
    ]);
  } catch {
    return fail(c, 409, "webhook_secret_import_conflict");
  }
  return c.json({ configured: true, installationId, secretName: "RESEND_WEBHOOK_SECRET" }, 201);
});

app.get("/api/installations/:id/secrets/:name/status", async c => {
  const name = c.req.param("name");
  if (name !== "RESEND_WEBHOOK_SECRET") return fail(c, 404, "secret_not_found");
  const found = await c.env.CONTROL_DB.prepare("SELECT updated_at FROM control_secrets WHERE installation_id=? AND secret_name=?").bind(c.req.param("id"), name).first();
  if (!found) return fail(c, 404, "secret_not_found");
  return c.json({ name, configured: true, updatedAt: found.updated_at });
});
app.post("/internal/installations/:id/resend/send", async c => {
  const installationId=c.req.param("id");
  if(!/^[a-f0-9-]{16,64}$/i.test(installationId))return fail(c,404,"installation_not_found");
  const auth=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("Authorization")||"");
  if(!auth||!c.env.CONTROL_PLANE_VAULT_KEY||c.env.CONTROL_PLANE_VAULT_KEY.length<32)return fail(c,401,"unauthorized");
  if(!equal(auth[1],await deriveResendRelayToken(c.env.CONTROL_PLANE_VAULT_KEY,installationId)))return fail(c,401,"unauthorized");
  const key=c.req.header("Idempotency-Key")||"";
  if(!/^[A-Za-z0-9._:-]{8,128}$/.test(key))return fail(c,400,"invalid_idempotency_key");
  const raw=await c.req.text();if(enc.encode(raw).byteLength>15*1024*1024)return fail(c,413,"payload_too_large");
  let payload:any;try{payload=JSON.parse(raw)}catch{return fail(c,400,"invalid_json")}
  if(!payload||typeof payload!=="object"||Array.isArray(payload)||typeof payload.from!=="string"||!Array.isArray(payload.to)||!payload.to.length||typeof payload.subject!=="string"||typeof payload.text!=="string")return fail(c,400,"invalid_resend_payload");
  const inst=await c.env.CONTROL_DB.prepare("SELECT i.status,i.provider_account_id,a.credentials_ciphertext,a.credentials_nonce,a.status AS provider_status FROM control_installations i JOIN control_provider_accounts a ON a.id=i.provider_account_id WHERE i.id=?").bind(installationId).first<any>();
  if(!inst||!["configuring","waiting_dns","verifying","bootstrapping","ready"].includes(inst.status)||inst.provider_status!=="active")return fail(c,409,"installation_or_provider_unavailable");
  let credentials:any;try{credentials=await openCredentials(c.env.CONTROL_PLANE_VAULT_KEY,inst.credentials_ciphertext,inst.credentials_nonce,"provider-account:"+inst.provider_account_id)}catch{return fail(c,503,"provider_credentials_unavailable")}
  const hash=await sha256(JSON.stringify(payload));
  let rec=await c.env.CONTROL_DB.prepare("SELECT id,payload_hash,status,provider_message_id,created_at FROM control_resend_send_requests WHERE provider_account_id=? AND idempotency_key=?").bind(inst.provider_account_id,key).first<any>();
  if(rec&&rec.payload_hash!==hash)return fail(c,409,"idempotency_key_reused_with_different_content");
  if(rec?.status==="sent"&&rec.provider_message_id)return c.json({id:rec.provider_message_id,reused:true});
  if(rec?.status==="uncertain"&&Date.parse(rec.created_at)<Date.now()-23*60*60*1000)return fail(c,409,"send_outcome_uncertain_manual_reconciliation_required");
  if(rec?.status==="failed"){
    const upd=await c.env.CONTROL_DB.prepare("UPDATE control_resend_send_requests SET status='reserved',day_key=date('now'),month_key=strftime('%Y-%m','now'),error_code=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='failed' AND (SELECT COUNT(*) FROM control_resend_send_requests WHERE provider_account_id=? AND day_key=date('now') AND status IN ('reserved','sent','uncertain'))<100 AND (SELECT COUNT(*) FROM control_resend_send_requests WHERE provider_account_id=? AND month_key=strftime('%Y-%m','now') AND status IN ('reserved','sent','uncertain'))<3000").bind(rec.id,inst.provider_account_id,inst.provider_account_id).run();
    if(!upd.meta.changes)return fail(c,429,"resend_free_quota_reached");
  }else if(!rec){
    const rid=id();
    await c.env.CONTROL_DB.prepare("INSERT INTO control_resend_send_requests(id,provider_account_id,installation_id,idempotency_key,payload_hash,status,day_key,month_key) SELECT ?,?,?,?,?,'reserved',date('now'),strftime('%Y-%m','now') WHERE (SELECT COUNT(*) FROM control_resend_send_requests WHERE provider_account_id=? AND day_key=date('now') AND status IN ('reserved','sent','uncertain'))<100 AND (SELECT COUNT(*) FROM control_resend_send_requests WHERE provider_account_id=? AND month_key=strftime('%Y-%m','now') AND status IN ('reserved','sent','uncertain'))<3000 ON CONFLICT(provider_account_id,idempotency_key) DO NOTHING").bind(rid,inst.provider_account_id,installationId,key,hash,inst.provider_account_id,inst.provider_account_id).run();
    rec=await c.env.CONTROL_DB.prepare("SELECT id,payload_hash,status,provider_message_id,created_at FROM control_resend_send_requests WHERE provider_account_id=? AND idempotency_key=?").bind(inst.provider_account_id,key).first<any>();
    if(!rec)return fail(c,429,"resend_free_quota_reached");
    if(rec.payload_hash!==hash)return fail(c,409,"idempotency_key_reused_with_different_content");
    if(rec.status==="sent"&&rec.provider_message_id)return c.json({id:rec.provider_message_id,reused:true});
  }
  try{
    const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:"Bearer "+credentials.resendApiKey,"Content-Type":"application/json","Idempotency-Key":key},body:JSON.stringify(payload),redirect:"error"});
    const result=await response.json().catch(()=>({} as any)) as {id?:string;data?:{id?:string}};
    const providerId=result.id||result.data?.id;
    if(response.ok&&providerId){
      await c.env.CONTROL_DB.prepare("UPDATE control_resend_send_requests SET status='sent',provider_message_id=?,error_code=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind(providerId,rec.id).run();
      await audit(c.env.CONTROL_DB,installationId,"resend.email.sent","success",{providerAccountId:inst.provider_account_id});return c.json({id:providerId});
    }
    await c.env.CONTROL_DB.prepare("UPDATE control_resend_send_requests SET status='failed',error_code=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind("http_"+response.status,rec.id).run();
    await audit(c.env.CONTROL_DB,installationId,"resend.email.rejected","failure",{providerStatus:response.status});
    return fail(c,response.status===429||response.status>=500?503:502,response.status===429||response.status>=500?"resend_temporarily_unavailable":"resend_rejected_message");
  }catch{
    await c.env.CONTROL_DB.prepare("UPDATE control_resend_send_requests SET status='uncertain',error_code='network_outcome_unknown',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind(rec.id).run();
    return fail(c,503,"resend_outcome_uncertain_retry_same_key");
  }
});

app.post("/webhooks/resend/:providerAccountId", async c => {
  const providerAccountId = c.req.param("providerAccountId");
  if (!/^[a-f0-9-]{16,64}$/i.test(providerAccountId)) return fail(c, 404, "webhook_not_found");
  const account = await c.env.CONTROL_DB.prepare(
    "SELECT webhook_endpoint,status FROM control_provider_accounts WHERE id=?"
  ).bind(providerAccountId).first<{ webhook_endpoint: string | null; status: string }>();
  let configuredOrigin = "";
  try {
    const configured = new URL(c.env.CONTROL_PLANE_PUBLIC_URL || "");
    if (configured.protocol === "https:" && configured.pathname === "/" && !configured.username &&
        !configured.password && !configured.search && !configured.hash) configuredOrigin = configured.origin;
  } catch { /* missing or invalid trusted public URL */ }
  if (!account || account.status !== "active" || !configuredOrigin ||
      account.webhook_endpoint !== configuredOrigin + c.req.path) {
    return fail(c, 404, "webhook_not_found");
  }
  const rawBody = await c.req.text();
  if (enc.encode(rawBody).byteLength > 1024 * 1024) return fail(c, 413, "payload_too_large");
  const secretRow = await c.env.CONTROL_DB.prepare(
    "SELECT ciphertext,nonce FROM control_provider_secrets WHERE provider_account_id=? AND secret_name='RESEND_WEBHOOK_SECRET'"
  ).bind(providerAccountId).first<{ ciphertext: string; nonce: string }>();
  if (!secretRow) return fail(c, 503, "webhook_not_configured");
  const signingSecret = await openProvisioningSecret(
    c.env.CONTROL_PLANE_VAULT_KEY, secretRow.ciphertext, secretRow.nonce,
    providerAccountId + ":RESEND_WEBHOOK_SECRET"
  );
  if (!await verifyResendWebhook(rawBody, c.req.raw, signingSecret)) {
    return fail(c, 401, "invalid_webhook_signature");
  }

  let event: { type?: string };
  try { event = JSON.parse(rawBody); } catch { return fail(c, 400, "invalid_payload"); }
  const eventId = c.req.header("svix-id") || "";
  if (!eventId || eventId.length > 200 || typeof event.type !== "string" || !event.type || event.type.length > 120) {
    return fail(c, 400, "invalid_event");
  }

  const knownEvent = await c.env.CONTROL_DB.prepare(
    "SELECT 1 AS found FROM control_webhook_events WHERE provider_account_id=? AND provider_event_id=?"
  ).bind(providerAccountId, eventId).first();
  if (!knownEvent) {
    const ready = await c.env.CONTROL_DB.prepare(
      "SELECT id FROM control_installations WHERE provider_account_id=? AND status='ready'"
    ).bind(providerAccountId).all<{ id: string }>();
    const targets = ready.results || [];
    const statements = [
      c.env.CONTROL_DB.prepare(
        "INSERT OR IGNORE INTO control_webhook_events (provider_account_id,provider_event_id,event_type,payload_json) VALUES (?,?,?,?)"
      ).bind(providerAccountId, eventId, event.type, rawBody),
      ...targets.map(target => c.env.CONTROL_DB.prepare(
        "INSERT OR IGNORE INTO control_webhook_deliveries (provider_account_id,provider_event_id,installation_id) VALUES (?,?,?)"
      ).bind(providerAccountId, eventId, target.id))
    ];
    await c.env.CONTROL_DB.batch(statements);
  }

  const pending = await c.env.CONTROL_DB.prepare(
    "SELECT d.installation_id,i.domain FROM control_webhook_deliveries d JOIN control_installations i ON i.id=d.installation_id WHERE d.provider_account_id=? AND d.provider_event_id=? AND d.status='pending'"
  ).bind(providerAccountId, eventId).all<{ installation_id: string; domain: string }>();
  let failed = 0;
  for (const delivery of pending.results || []) {
    const workerSecret = await c.env.CONTROL_DB.prepare(
      "SELECT 1 AS configured FROM control_secrets WHERE installation_id=? AND secret_name='RESEND_WEBHOOK_SECRET'"
    ).bind(delivery.installation_id).first();
    if (!workerSecret) {
      failed++;
      await c.env.CONTROL_DB.prepare(
        "UPDATE control_webhook_deliveries SET attempts=attempts+1,last_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_error='worker_webhook_secret_missing' WHERE provider_account_id=? AND provider_event_id=? AND installation_id=?"
      ).bind(providerAccountId, eventId, delivery.installation_id).run();
      continue;
    }
    let response: Response | null = null;
    try {
      response = await fetch("https://mail." + delivery.domain + "/api/webhooks/resend", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "svix-id": eventId,
          "svix-timestamp": c.req.header("svix-timestamp") || "",
          "svix-signature": c.req.header("svix-signature") || ""
        },
        body: rawBody,
        redirect: "error"
      });
    } catch {
      response = null;
    }
    if (response?.ok) {
      await c.env.CONTROL_DB.prepare(
        "UPDATE control_webhook_deliveries SET status='delivered',attempts=attempts+1,last_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),delivered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_error=NULL WHERE provider_account_id=? AND provider_event_id=? AND installation_id=?"
      ).bind(providerAccountId, eventId, delivery.installation_id).run();
    } else {
      failed++;
      await c.env.CONTROL_DB.prepare(
        "UPDATE control_webhook_deliveries SET attempts=attempts+1,last_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_error=? WHERE provider_account_id=? AND provider_event_id=? AND installation_id=?"
      ).bind(response ? "worker_http_" + response.status : "worker_unreachable", providerAccountId, eventId, delivery.installation_id).run();
    }
  }
  if (failed) return c.json({ accepted: true, pendingDeliveries: failed }, 503);
  await c.env.CONTROL_DB.prepare(
    "UPDATE control_webhook_events SET payload_json='{}' WHERE provider_account_id=? AND provider_event_id=? AND NOT EXISTS (SELECT 1 FROM control_webhook_deliveries WHERE provider_account_id=? AND provider_event_id=? AND status='pending')"
  ).bind(providerAccountId, eventId, providerAccountId, eventId).run();
  return c.body(null, 204);
});

app.notFound(c => fail(c, 404, "not_found"));
app.onError(async (_error, c) => fail(c, 500, "internal_error"));
export default {
  fetch: app.fetch.bind(app),
  async queue(batch: MessageBatch<{ installationId: string; jobId: string } | { type: "maintenance"; installationIds: string[]; slot: string }>, env: Env) {
    for (const message of batch.messages) {
      try {
        if ("installationIds" in message.body) {
          const ids = message.body.installationIds;
          if (!Array.isArray(ids) || ids.length < 1 || ids.length > 10 || ids.some(value => typeof value !== "string" || !/^[a-f0-9-]{16,64}$/i.test(value))) {
            message.ack();
            continue;
          }
          await processMaintenanceBatch(env, ids, message.body.slot);
        } else {
          await processProvisioningJob(env, message.body.installationId, message.body.jobId);
        }
        message.ack();
      } catch (error: unknown) {
        const failure = error as {
          name?: string;
          provider?: string;
          status?: number;
          retryable?: boolean;
        };

        console.error("MSM_QUEUE_PROCESSING_FAILED", {
          errorType: failure?.name ?? "UnknownError",
          provider: failure?.provider ?? "internal",
          status: failure?.status ?? null,
          retryable: failure?.retryable === true
        });

        message.retry({ delaySeconds: 120 });
      }
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const expired = await env.CONTROL_DB.prepare(
        "SELECT installation_id FROM control_provisioning_jobs WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')"
      ).all<{ installation_id: string }>();
      for (const row of expired.results || []) {
        await env.CONTROL_DB.prepare(
          "UPDATE control_installations SET status='failed',current_step='credentials_expired',provision_lock=NULL,lock_expires_at=NULL,error_code='credentials_expired',error_message='Temporary provider authorization expired. Submit a new provisioning request.',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='provisioning'"
        ).bind(row.installation_id).run();
      }
      await env.CONTROL_DB.prepare(
        "DELETE FROM control_provisioning_jobs WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')"
      ).run();
      await env.CONTROL_DB.prepare(
        "DELETE FROM control_maintenance_dispatches WHERE scheduled_slot < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"
      ).run();
      await env.CONTROL_DB.prepare(
        "DELETE FROM control_webhook_events WHERE received_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') AND NOT EXISTS (SELECT 1 FROM control_webhook_deliveries d WHERE d.provider_account_id=control_webhook_events.provider_account_id AND d.provider_event_id=control_webhook_events.provider_event_id AND d.status='pending')"
      ).run();

      // One Cron trigger: cleanup every 5m, maintenance fan-out every 15m.
      const now = new Date();
      if (now.getUTCMinutes() % 15 < 10) {
        const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), Math.floor(now.getUTCMinutes() / 15) * 15)).toISOString();
        const ready = await env.CONTROL_DB.prepare(
          "SELECT id FROM control_installations WHERE status='ready' ORDER BY updated_at LIMIT 99"
        ).all<{ id: string }>();
        const ids = (ready.results || []).map(row => row.id);
        for (let offset = 0; offset < ids.length; offset += 10) {
          const chunk = ids.slice(offset, offset + 10);
          const claims = await env.CONTROL_DB.batch(chunk.map(installationId =>
            env.CONTROL_DB.prepare("INSERT OR IGNORE INTO control_maintenance_dispatches (installation_id,scheduled_slot) VALUES (?,?)").bind(installationId, slot)
          ));
          const claimed = chunk.filter((_value, index) => (claims[index]?.meta.changes || 0) > 0);
          if (!claimed.length) continue;
          try {
            await env.PROVISIONING_QUEUE.send({ type: "maintenance", installationIds: claimed, slot });
          } catch {
            await env.CONTROL_DB.batch(claimed.map(installationId =>
              env.CONTROL_DB.prepare("DELETE FROM control_maintenance_dispatches WHERE installation_id=? AND scheduled_slot=?").bind(installationId, slot)
            ));
          }
        }
      }
    })());
  }
};
