import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON;");
const migrationsDir = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrationsDir).filter(file => file.endsWith(".sql")).sort();
for (const file of files) {
  database.exec(readFileSync(new URL(file, migrationsDir), "utf8"));
  process.stdout.write("Applied " + file + "\n");
}
const violations = database.prepare("PRAGMA foreign_key_check").all();
if (violations.length) throw new Error("Mail database foreign key violations: " + JSON.stringify(violations));
process.stdout.write("Validated " + files.length + " mail database migrations.\n");
database.close();

const controlDatabase = new DatabaseSync(":memory:");
controlDatabase.exec("PRAGMA foreign_keys = ON;");
const controlMigrationsDir = new URL("../control-plane/migrations/", import.meta.url);
const controlFiles = readdirSync(controlMigrationsDir).filter(file => file.endsWith(".sql")).sort();
for (const file of controlFiles) {
  controlDatabase.exec(readFileSync(new URL(file, controlMigrationsDir), "utf8"));
  process.stdout.write("Applied control-plane " + file + "\n");
}
const controlViolations = controlDatabase.prepare("PRAGMA foreign_key_check").all();
if (controlViolations.length) throw new Error("Control-plane foreign key violations: " + JSON.stringify(controlViolations));

// Exercise the account-scoped provisioning lease: a second installation must
// not acquire the same account while the first lease is live, but may take it
// after expiry. A stale owner must never delete the replacement lease.
const insertInstallation = controlDatabase.prepare(
  "INSERT INTO control_installations (id,app_name,worker_name,domain,admin_email) VALUES (?,?,?,?,?)"
);
insertInstallation.run("install-a", "App A", "worker-a", "a.example.com", "admin-a@example.com");
insertInstallation.run("install-b", "App B", "worker-b", "b.example.com", "admin-b@example.com");
const acquireAccountLease = controlDatabase.prepare(
  "INSERT INTO control_account_provisioning_locks (cloudflare_account_id,installation_id,lease_id,expires_at) VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes')) ON CONFLICT(cloudflare_account_id) DO UPDATE SET installation_id=excluded.installation_id,lease_id=excluded.lease_id,expires_at=excluded.expires_at WHERE control_account_provisioning_locks.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')"
);
acquireAccountLease.run("account-1", "install-a", "lease-a");
acquireAccountLease.run("account-1", "install-b", "lease-b");
let accountLease = controlDatabase.prepare(
  "SELECT installation_id,lease_id FROM control_account_provisioning_locks WHERE cloudflare_account_id=?"
).get("account-1");
if (accountLease?.installation_id !== "install-a" || accountLease?.lease_id !== "lease-a") {
  throw new Error("Account provisioning lease allowed concurrent ownership.");
}
controlDatabase.prepare(
  "UPDATE control_account_provisioning_locks SET expires_at='2000-01-01T00:00:00.000Z' WHERE cloudflare_account_id=?"
).run("account-1");
acquireAccountLease.run("account-1", "install-b", "lease-b");
controlDatabase.prepare(
  "DELETE FROM control_account_provisioning_locks WHERE cloudflare_account_id=? AND lease_id=?"
).run("account-1", "lease-a");
accountLease = controlDatabase.prepare(
  "SELECT installation_id,lease_id FROM control_account_provisioning_locks WHERE cloudflare_account_id=?"
).get("account-1");
if (accountLease?.installation_id !== "install-b" || accountLease?.lease_id !== "lease-b") {
  throw new Error("Expired lease recovery or stale-owner fencing failed.");
}

const insertProviderAccount = controlDatabase.prepare(
  "INSERT INTO control_provider_accounts (id,cloudflare_account_id,credentials_ciphertext,credentials_nonce) VALUES (?,?,?,?)"
);
insertProviderAccount.run("provider-a", "account-shared", "encrypted-test-payload", "test-nonce");
const linkInstallation = controlDatabase.prepare(
  "UPDATE control_installations SET provider_account_id=? WHERE id=?"
);
linkInstallation.run("provider-a", "install-a");
linkInstallation.run("provider-a", "install-b");
let domainLimitRejected = false;
try {
  controlDatabase.prepare(
    "INSERT INTO control_installations (id,app_name,worker_name,domain,admin_email,provider_account_id) VALUES (?,?,?,?,?,?)"
  ).run("install-c", "App C", "worker-c", "c.example.com", "admin-c@example.com", "provider-a");
} catch (error) {
  domainLimitRejected = String(error?.message || error).includes("provider_account_domain_limit_reached");
}
if (!domainLimitRejected) throw new Error("Provider account accepted more than two managed domains.");
const providerSummary = controlDatabase.prepare(
  "SELECT COUNT(*) AS domains FROM control_installations WHERE provider_account_id=?"
).get("provider-a");
if (providerSummary?.domains !== 2) throw new Error("Provider account domain count is incorrect.");
controlDatabase.prepare(
  "INSERT INTO control_provider_secrets (provider_account_id,secret_name,ciphertext,nonce) VALUES (?,?,?,?)"
).run("provider-a", "RESEND_WEBHOOK_SECRET", "encrypted-signing-secret", "secret-nonce");

process.stdout.write("Validated " + controlFiles.length + " control-plane migrations and account lease fencing.\n");
controlDatabase.close();
