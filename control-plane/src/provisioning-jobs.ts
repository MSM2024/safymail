import { provisionCoreResources } from "../../src/provisioning/orchestrator";

export interface ProvisioningJobEnv {
  CONTROL_DB: D1Database;
  CONTROL_PLANE_VAULT_KEY: string;
}

interface StoredCredentials {
  cloudflareApiToken: string;
  cloudflareAccountId: string;
  resendApiKey: string;
}

const encoder = new TextEncoder();
const id = () => crypto.randomUUID();
function b64(bytes: Uint8Array): string {
  let raw = "";
  bytes.forEach(value => raw += String.fromCharCode(value));
  return btoa(raw);
}
function unb64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), value => value.charCodeAt(0));
}
function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
async function encryptionKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function sealCredentials(master: string, value: StoredCredentials, context: string) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(context) },
    await encryptionKey(master),
    encoder.encode(JSON.stringify(value))
  );
  return { ciphertext: b64(new Uint8Array(ciphertext)), nonce: b64(nonce) };
}
export async function openCredentials(master: string, ciphertext: string, nonce: string, context: string): Promise<StoredCredentials> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(unb64(nonce)), additionalData: encoder.encode(context) },
    await encryptionKey(master),
    asArrayBuffer(unb64(ciphertext))
  );
  const value = JSON.parse(new TextDecoder().decode(plaintext));
  if (!value || typeof value.cloudflareApiToken !== "string" || typeof value.cloudflareAccountId !== "string" || typeof value.resendApiKey !== "string") {
    throw new Error("Stored provisioning credential envelope is invalid.");
  }
  return value;
}
export async function openProvisioningSecret(master: string, ciphertext: string, nonce: string, context: string): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(unb64(nonce)), additionalData: encoder.encode(context) },
    await encryptionKey(master),
    asArrayBuffer(unb64(ciphertext))
  );
  return new TextDecoder().decode(plaintext);
}
async function sealSecret(master: string, value: string, context: string) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(context) },
    await encryptionKey(master),
    encoder.encode(value)
  );
  return { ciphertext: b64(new Uint8Array(ciphertext)), nonce: b64(nonce) };
}
async function audit(db: D1Database, installationId: string, action: string, outcome: "success" | "failure", metadata: Record<string, unknown> = {}) {
  await db.prepare("INSERT INTO control_audit_logs (id,installation_id,action,outcome,metadata_json) VALUES (?,?,?,?,?)")
    .bind(id(), installationId, action, outcome, JSON.stringify(metadata)).run();
}

export async function deriveMaintenanceTokens(master: string, installationIds: string[]): Promise<string[]> {
  if (!master || master.length < 32 || !Array.isArray(installationIds) ||
      installationIds.some(value => !/^[a-f0-9-]{16,64}$/i.test(value))) {
    throw new Error("Invalid maintenance token derivation input.");
  }
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(master), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return Promise.all(installationIds.map(async installationId => {
    const signature = new Uint8Array(await crypto.subtle.sign(
      "HMAC", key, encoder.encode("mail-center-maintenance:v1:" + installationId)
    ));
    return b64(signature).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }));
}

export async function deriveMaintenanceToken(master: string, installationId: string): Promise<string> {
  return (await deriveMaintenanceTokens(master, [installationId]))[0];
}

export async function deriveResendRelayToken(master: string, installationId: string): Promise<string> {
  if (!master || master.length < 32 || !/^[a-f0-9-]{16,64}$/i.test(installationId)) throw new Error("Invalid relay token input.");
  const key = await crypto.subtle.importKey("raw", encoder.encode(master), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC",key,encoder.encode("mail-center-resend-relay:v1:"+installationId)));
  return b64(sig).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}

export async function processProvisioningJob(env: ProvisioningJobEnv, installationId: string, jobId: string): Promise<void> {
  const job = await env.CONTROL_DB.prepare(
    "SELECT ciphertext,nonce,expires_at FROM control_provisioning_jobs WHERE installation_id=? AND job_id=?"
  ).bind(installationId, jobId).first<{ ciphertext: string; nonce: string; expires_at: string }>();
  if (!job) return; // Duplicate or already completed delivery.
  const expiry = Date.parse(job.expires_at);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    await env.CONTROL_DB.prepare("DELETE FROM control_provisioning_jobs WHERE installation_id=? AND job_id=?").bind(installationId, jobId).run();
    await env.CONTROL_DB.prepare("UPDATE control_installations SET status='failed',current_step='credentials_expired',error_code='credentials_expired',error_message='Temporary provider authorization expired. Submit a new provisioning request.',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='provisioning' AND current_step IN ('queued','processing')").bind(installationId).run();
    await audit(env.CONTROL_DB, installationId, "provisioning.credentials_expired", "failure");
    return;
  }

  const leaseId = id();
  const lease = await env.CONTROL_DB.prepare(
    "UPDATE control_installations SET provision_lock=?,lock_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'),current_step='processing',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='provisioning' AND current_step IN ('queued','processing') AND (lock_expires_at IS NULL OR lock_expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
  ).bind(leaseId, installationId).run();
  if (!lease.meta.changes) {
    const state = await env.CONTROL_DB.prepare("SELECT status,current_step FROM control_installations WHERE id=?").bind(installationId).first<any>();
    if (state?.status === "provisioning" && ["queued", "processing"].includes(state.current_step || "")) {
      throw Object.assign(new Error("Provisioning lease is currently held by another delivery."), { retryable: true, status: 503 });
    }
    return; // Job is complete, cancelled, or no longer active.
  }

  let accountLock: { accountId: string; leaseId: string } | null = null;
  try {
    const credentials = await openCredentials(env.CONTROL_PLANE_VAULT_KEY, job.ciphertext, job.nonce, installationId + ":" + jobId);
    const installation = await env.CONTROL_DB.prepare(
      "SELECT id,app_name,worker_name,domain,resend_region,cloudflare_account_id,provider_account_id FROM control_installations WHERE id=?"
    ).bind(installationId).first<any>();
    if (!installation) throw new Error("Installation disappeared during provisioning.");
    if (installation.cloudflare_account_id && String(installation.cloudflare_account_id).toLowerCase() !== credentials.cloudflareAccountId.toLowerCase()) {
      throw new Error("Cloudflare account authorization does not match the installation record.");
    }
    const providerAccount = await env.CONTROL_DB.prepare(
      "SELECT webhook_endpoint,status FROM control_provider_accounts WHERE id=?"
    ).bind(installation.provider_account_id).first<{ webhook_endpoint: string | null; status: string }>();
    if (!providerAccount || providerAccount.status !== "active" || !providerAccount.webhook_endpoint) {
      throw new Error("provider_account_webhook_not_configured");
    }
    const managedCount = await env.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS domains FROM control_installations WHERE provider_account_id=?"
    ).bind(installation.provider_account_id).first<{ domains: number }>();
    const storedSharedSecret = await env.CONTROL_DB.prepare(
      "SELECT ciphertext,nonce FROM control_provider_secrets WHERE provider_account_id=? AND secret_name='RESEND_WEBHOOK_SECRET'"
    ).bind(installation.provider_account_id).first<{ ciphertext: string; nonce: string }>();
    const existingSharedWebhookSecret = storedSharedSecret
      ? await openProvisioningSecret(env.CONTROL_PLANE_VAULT_KEY, storedSharedSecret.ciphertext, storedSharedSecret.nonce, installation.provider_account_id + ":RESEND_WEBHOOK_SECRET")
      : undefined;

    // Serialize provisioning jobs that share one Cloudflare account. Without
    // this lease, parallel installs could both pass the same account quota
    // preflight and then over-allocate D1, Workers, or KV namespaces.
    const accountLeaseId = id();
    const accountLease = await env.CONTROL_DB.prepare(
      "INSERT INTO control_account_provisioning_locks (cloudflare_account_id,installation_id,lease_id,expires_at) VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes')) ON CONFLICT(cloudflare_account_id) DO UPDATE SET installation_id=excluded.installation_id,lease_id=excluded.lease_id,expires_at=excluded.expires_at WHERE control_account_provisioning_locks.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')"
    ).bind(credentials.cloudflareAccountId.toLowerCase(), installationId, accountLeaseId).run();
    if (!accountLease.meta.changes) {
      throw Object.assign(new Error("Another installation is provisioning resources in this Cloudflare account."), { retryable: true, status: 503 });
    }
    accountLock = { accountId: credentials.cloudflareAccountId.toLowerCase(), leaseId: accountLeaseId };

    const result = await provisionCoreResources({
      installationId, providerAccountId: installation.provider_account_id, appName: installation.app_name, workerName: installation.worker_name,
      domain: installation.domain, resendRegion: installation.resend_region,
      webhookEndpoint: providerAccount.webhook_endpoint,
      managedDomainCount: managedCount?.domains || 1,
      cloudflare: { accountId: credentials.cloudflareAccountId, apiToken: credentials.cloudflareApiToken },
      resend: { apiKey: credentials.resendApiKey, existingWebhookSecret: existingSharedWebhookSecret },
      onSecret: async (name, value) => {
        const shared = await sealSecret(env.CONTROL_PLANE_VAULT_KEY, value, installation.provider_account_id + ":" + name);
        await env.CONTROL_DB.prepare(
          "INSERT OR REPLACE INTO control_provider_secrets (provider_account_id,secret_name,ciphertext,nonce,algorithm,updated_at) VALUES (?,?,?,?,'AES-GCM-256',strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
        ).bind(installation.provider_account_id, name, shared.ciphertext, shared.nonce).run();
        const sealed = await sealSecret(env.CONTROL_PLANE_VAULT_KEY, value, installationId + ":" + name);
        const stored = await env.CONTROL_DB.prepare(
          "INSERT OR REPLACE INTO control_secrets (installation_id,secret_name,ciphertext,nonce,algorithm,updated_at) SELECT ?,?,?,?,'AES-GCM-256',strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE EXISTS (SELECT 1 FROM control_installations WHERE id=? AND provision_lock=?)"
        ).bind(installationId, name, sealed.ciphertext, sealed.nonce, installationId, leaseId).run();
        if (!stored.meta.changes) throw new Error("Provisioning lease lost before secret storage.");
      },
      onCheckpoint: async (step, details) => {
        const key = step + ":" + (typeof details.id === "string" ? details.id : "verified");
        await env.CONTROL_DB.prepare(
          "INSERT OR IGNORE INTO control_checkpoints (id,installation_id,step,status,details_json,idempotency_key) SELECT ?,?,?, 'completed',?,? WHERE EXISTS (SELECT 1 FROM control_installations WHERE id=? AND provision_lock=?)"
        ).bind(id(), installationId, step, JSON.stringify(details), key, installationId, leaseId).run();
        const owned = await env.CONTROL_DB.prepare(
          "UPDATE control_installations SET current_step=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND provision_lock=?"
        ).bind(step, installationId, leaseId).run();
        if (!owned.meta.changes) throw new Error("Provisioning lease lost before checkpoint storage.");
      }
    });
    const finalized = await env.CONTROL_DB.prepare(
      "UPDATE control_installations SET status='configuring',current_step='resources_ready',provision_lock=NULL,lock_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND provision_lock=?"
    ).bind(installationId, leaseId).run();
    if (!finalized.meta.changes) throw new Error("Provisioning lease lost before finalization.");
    await env.CONTROL_DB.prepare("DELETE FROM control_provisioning_jobs WHERE installation_id=? AND job_id=?").bind(installationId, jobId).run();
    await audit(env.CONTROL_DB, installationId, "provisioning.core_resources", "success", {
      d1Created: result.resources.d1.created, kvCreated: result.resources.kv.created,
      resendDomainCreated: result.resources.resendDomain.created, webhookCreated: result.resources.resendWebhook.created
    });
  } catch (error: any) {
    const permanentErrors = new Set(["domain_zone_not_found", "domain_zone_not_active"]);
    const retryable = error?.retryable === true || error?.status === 429 ||
      (typeof error?.status === "number" && error.status >= 500) ||
      (!error?.provider && !permanentErrors.has(String(error?.message || "")));
    if (retryable) {
      await env.CONTROL_DB.prepare(
        "UPDATE control_installations SET current_step='queued',provision_lock=NULL,lock_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND provision_lock=?"
      ).bind(installationId, leaseId).run();
      throw error;
    }
    const code = typeof error?.provider === "string" ? "provider_" + error.provider : "provisioning_failed";
    await env.CONTROL_DB.prepare(
      "UPDATE control_installations SET status='failed',provision_lock=NULL,lock_expires_at=NULL,error_code=?,error_message='Provisioning failed. Review provider permissions and submit a new request.',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND provision_lock=?"
    ).bind(code, installationId, leaseId).run();
    await env.CONTROL_DB.prepare("DELETE FROM control_provisioning_jobs WHERE installation_id=? AND job_id=?").bind(installationId, jobId).run();
    await audit(env.CONTROL_DB, installationId, "provisioning.core_resources", "failure", { code });
  } finally {
    if (accountLock) {
      await env.CONTROL_DB.prepare(
        "DELETE FROM control_account_provisioning_locks WHERE cloudflare_account_id=? AND lease_id=?"
      ).bind(accountLock.accountId, accountLock.leaseId).run();
    }
  }
}
