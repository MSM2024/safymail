import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const required = ["CONTROL_PLANE_URL", "CONTROL_PLANE_ADMIN_TOKEN", "INSTALLATION_ID", "CLOUDFLARE_API_TOKEN", "RESEND_API_KEY", "TOTP_ENCRYPTION_KEY"];
for (const key of required) {
  if (!env[key]?.trim()) {
    console.error("[deploy] Missing environment variable: " + key + ". Nothing was deployed.");
    process.exit(1);
  }
}
if (!/^https:\/\//i.test(env.CONTROL_PLANE_URL)) {
  console.error("[deploy] CONTROL_PLANE_URL must use HTTPS. Nothing was deployed.");
  process.exit(1);
}
if (!/^[a-f0-9-]{16,64}$/i.test(env.INSTALLATION_ID)) {
  console.error("[deploy] INSTALLATION_ID is invalid. Nothing was deployed.");
  process.exit(1);
}
if (!/^re_[A-Za-z0-9_]{20,}$/.test(env.RESEND_API_KEY)) {
  console.error("[deploy] RESEND_API_KEY does not look like a Resend API key. Nothing was deployed.");
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{43}$/.test(env.TOTP_ENCRYPTION_KEY.trim())) {
  console.error("[deploy] TOTP_ENCRYPTION_KEY must be a 32-byte base64url value. Nothing was deployed.");
  process.exit(1);
}

const baseUrl = env.CONTROL_PLANE_URL.replace(/\/+$/, "");
const manifestResponse = await fetch(
  baseUrl + "/api/installations/" + encodeURIComponent(env.INSTALLATION_ID) + "/deployment-config",
  { headers: { Authorization: "Bearer " + env.CONTROL_PLANE_ADMIN_TOKEN, Accept: "application/json" }, redirect: "error" }
);
if (!manifestResponse.ok) {
  console.error("[deploy] Control plane rejected deployment manifest request (" + manifestResponse.status + "). No local configuration or Cloudflare resource was changed.");
  process.exit(1);
}
const manifest = await manifestResponse.json();
const validId = (value, pattern) => typeof value === "string" && pattern.test(value);
if (manifest.installationId !== env.INSTALLATION_ID ||
    !validId(manifest.workerName, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/) ||
    !validId(manifest.cloudflare?.accountId, /^[a-f0-9]{32}$/i) ||
    !validId(manifest.cloudflare?.zoneId, /^[a-f0-9]{32}$/i) ||
    !validId(manifest.resources?.d1DatabaseId, /^[a-f0-9-]{36}$/i) ||
    !validId(manifest.resources?.d1DatabaseName, /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/i) ||
    !validId(manifest.resources?.kvNamespaceId, /^[a-f0-9]{32}$/i) ||
    !validId(manifest.runtimeSecrets?.resendWebhookSecret, /^whsec_[A-Za-z0-9_-]{20,}$/) ||
    !validId(manifest.runtimeSecrets?.maintenanceToken, /^[A-Za-z0-9_-]{43}$/) ||
    !validId(manifest.runtimeSecrets?.resendRelayToken, /^[A-Za-z0-9_-]{43}$/)) {
  console.error("[deploy] Control-plane deployment manifest is incomplete or invalid. Nothing was deployed.");
  process.exit(1);
}

function run(command, args, options = {}) {
  const childEnv = {};
  for (const key of ["PATH", "PATHEXT", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "COMSPEC", "TMP", "TEMP", "CI"]) {
    if (env[key] !== undefined) childEnv[key] = env[key];
  }
  // Only Wrangler needs the Cloudflare token. Never pass the control-plane
  // bearer, Resend key or TOTP key into npm/Wrangler child processes.
  if (options.cloudflareAuth) childEnv.CLOUDFLARE_API_TOKEN = env.CLOUDFLARE_API_TOKEN;
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...childEnv, ...options.env },
    stdio: options.input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    input: options.input,
    shell: process.platform === "win32"
  });
  if (result.error || result.status !== 0) {
    console.error("[deploy] Command failed: " + command + " " + args.join(" "));
    process.exit(result.status || 1);
  }
}
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const installation = {
  appName: manifest.appName,
  workerName: manifest.workerName,
  environment: "production",
  domain: manifest.domain,
  adminEmail: manifest.adminEmail,
  resendRegion: manifest.resendRegion || "eu-west-1",
  controlPlaneUrl: baseUrl,
  installationId: manifest.installationId,
  cloudflare: { accountId: manifest.cloudflare.accountId, zoneId: manifest.cloudflare.zoneId },
  resources: {
    d1DatabaseName: manifest.resources.d1DatabaseName,
    d1DatabaseId: manifest.resources.d1DatabaseId,
    kvNamespaceId: manifest.resources.kvNamespaceId
  }
};
const configPath = path.join(root, "installation.json");
fs.writeFileSync(configPath, JSON.stringify(installation, null, 2) + "\n", { mode: 0o600 });
fs.chmodSync(configPath, 0o600);
run(npm, ["run", "configure:installation"]);
const wranglerConfig = path.join(root, "wrangler.toml");
if (!fs.existsSync(wranglerConfig)) {
  console.error("[deploy] Wrangler configuration was not generated. No remote action was attempted.");
  process.exit(1);
}

console.log("[deploy] Applying dedicated D1 migrations...");
run(npx, ["wrangler", "d1", "migrations", "apply", manifest.resources.d1DatabaseName, "--remote", "--config", "wrangler.toml"], { cloudflareAuth: true });
console.log("[deploy] Deploying Worker...");
run(npx, ["wrangler", "deploy", "--config", "wrangler.toml"], { cloudflareAuth: true });

const bootstrapToken = randomBytes(32).toString("base64url");
const totpKey = env.TOTP_ENCRYPTION_KEY.trim();
const secrets = [
  ["RESEND_API_KEY", env.RESEND_API_KEY],
  ["RESEND_WEBHOOK_SECRET", manifest.runtimeSecrets.resendWebhookSecret],
  ["MAINTENANCE_TOKEN", manifest.runtimeSecrets.maintenanceToken],
  ["RESEND_RELAY_TOKEN", manifest.runtimeSecrets.resendRelayToken],
  ["TOTP_ENCRYPTION_KEY", totpKey],
  ["BOOTSTRAP_TOKEN", bootstrapToken]
];
for (const [name, value] of secrets) {
  if (!value || /[\r\n]/.test(value)) {
    console.error("[deploy] Invalid value for runtime secret " + name + ". Worker deployment may be incomplete.");
    process.exit(1);
  }
  console.log("[deploy] Installing secret " + name + "...");
  run(npx, ["wrangler", "secret", "put", name, "--name", manifest.workerName, "--config", "wrangler.toml"], { input: value + "\n", cloudflareAuth: true });
}

console.log("\n[deploy] Worker deployment and runtime secret installation completed.");
console.log("Worker: " + manifest.workerName);
console.log("Domain: " + manifest.domain);
try {
  const apiHeaders = { Authorization: "Bearer " + env.CLOUDFLARE_API_TOKEN, Accept: "application/json" };
  const scriptSubdomainResponse = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" + manifest.cloudflare.accountId + "/workers/scripts/" + encodeURIComponent(manifest.workerName) + "/subdomain",
    { headers: apiHeaders, redirect: "error" }
  );
  const scriptSubdomain = await scriptSubdomainResponse.json().catch(() => null);
  const accountSubdomainResponse = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" + manifest.cloudflare.accountId + "/workers/subdomain",
    { headers: apiHeaders, redirect: "error" }
  );
  const accountSubdomain = await accountSubdomainResponse.json().catch(() => null);
  if (scriptSubdomainResponse.ok && scriptSubdomain?.result?.enabled === true &&
      accountSubdomainResponse.ok && /^[a-z0-9-]+$/.test(accountSubdomain?.result?.subdomain || "")) {
    console.log("Temporary Worker URL: https://" + manifest.workerName + "." + accountSubdomain.result.subdomain + ".workers.dev");
    console.log("Admin page: https://" + manifest.workerName + "." + accountSubdomain.result.subdomain + ".workers.dev/admin.html");
  } else {
    console.log("Workers.dev is not enabled for this Worker. Use the domain after its custom route is configured.");
  }
} catch {
  console.log("Could not determine the workers.dev URL. Check the Wrangler deploy output above.");
}
console.log("Bootstrap token (shown once; use it immediately to create the first administrator): " + bootstrapToken);
console.log("The installation remains in 'configuring'. DNS, Email Routing, administrator bootstrap, custom-domain verification and end-to-end checks are still required before it can become ready.");
