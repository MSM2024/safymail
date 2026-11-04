import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rawControlPlaneUrl = process.env.CONTROL_PLANE_URL || "";
const controlPlaneUrl = rawControlPlaneUrl.endsWith("/") ? rawControlPlaneUrl.slice(0, -1) : rawControlPlaneUrl;
const adminToken = process.env.CONTROL_PLANE_ADMIN_TOKEN || "";
const installationId = process.env.INSTALLATION_ID || "";

if (!controlPlaneUrl || !adminToken || !/^[a-f0-9-]{16,64}$/i.test(installationId)) {
  console.error("Set CONTROL_PLANE_URL, CONTROL_PLANE_ADMIN_TOKEN and INSTALLATION_ID. No secret was changed.");
  process.exit(2);
}
let endpoint;
try {
  endpoint = new URL("/api/installations/" + encodeURIComponent(installationId) + "/runtime-config", controlPlaneUrl);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
    throw new Error("HTTPS required");
  }
} catch {
  console.error("CONTROL_PLANE_URL must be a valid HTTPS URL. No secret was changed.");
  process.exit(2);
}

let response;
try {
  response = await fetch(endpoint, {
    headers: { Authorization: "Bearer " + adminToken, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15000)
  });
} catch {
  console.error("Could not reach the control plane. No secret was changed.");
  process.exit(1);
}
if (!response.ok) {
  console.error("The control plane did not authorize runtime configuration (HTTP " + response.status + "). No secret was changed.");
  process.exit(1);
}
const payload = await response.json().catch(() => null);
const workerName = payload?.workerName;
const accountId = payload?.accountId;
const token = payload?.maintenance?.authorization;
if (typeof workerName !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workerName) ||
    typeof accountId !== "string" || !/^[a-f0-9]{32}$/i.test(accountId) || typeof token !== "string" || !/^Bearer [A-Za-z0-9_-]{43}$/.test(token)) {
  console.error("The control plane returned an invalid runtime configuration. No secret was changed.");
  process.exit(1);
}

const wranglerConfigPath = path.join(root, "wrangler.toml");
let wranglerConfig = "";
try { wranglerConfig = readFileSync(wranglerConfigPath, "utf8"); } catch {
  console.error("Run npm run configure:installation first so wrangler.toml exists. No secret was changed.");
  process.exit(1);
}
const configuredAccount = /^\s*account_id\s*=\s*["']([a-f0-9]{32})["']/im.exec(wranglerConfig)?.[1];
if (!configuredAccount || configuredAccount.toLowerCase() !== accountId.toLowerCase()) {
  console.error("The local wrangler.toml account_id does not match the installation account. No secret was changed.");
  process.exit(1);
}

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const wranglerEnv = { ...process.env };
delete wranglerEnv.CONTROL_PLANE_ADMIN_TOKEN;
delete wranglerEnv.CONTROL_PLANE_URL;
delete wranglerEnv.INSTALLATION_ID;
const result = spawnSync(command, ["wrangler", "secret", "put", "MAINTENANCE_TOKEN", "--name", workerName, "--config", wranglerConfigPath], {
  cwd: root,
  env: wranglerEnv,
  input: token.slice("Bearer ".length) + "\n",
  encoding: "utf8",
  shell: process.platform === "win32",
  timeout: 60000
});
if (result.status !== 0) {
  console.error("Wrangler could not install MAINTENANCE_TOKEN for Worker " + workerName + ". Confirm the Worker is deployed and Wrangler is authenticated. The token was not printed.");
  process.exit(result.status || 1);
}
console.log("MAINTENANCE_TOKEN installed for Worker " + workerName + ". The secret value was not displayed or saved locally.");
