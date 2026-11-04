import { assessWorkerDomain, hasDnsConflictForCustomDomain, hasWorkerRouteConflict, type WorkerDomainState } from "../src/provisioning/custom-domain-plan";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const env = process.env;
for (const key of ["CONTROL_PLANE_URL", "CONTROL_PLANE_ADMIN_TOKEN", "INSTALLATION_ID", "CLOUDFLARE_API_TOKEN"]) {
  if (!env[key]?.trim()) {
    console.error("[custom-domain] Missing environment variable: " + key + ".");
    process.exit(1);
  }
}
const applying = process.argv.includes("--apply");
if (applying && (!stdin.isTTY || !stdout.isTTY)) {
  console.error("[custom-domain] Interactive terminal confirmation is required. No domain was attached.");
  process.exit(1);
}
if (!/^https:\/\//i.test(env.CONTROL_PLANE_URL!)) {
  console.error("[custom-domain] CONTROL_PLANE_URL must use HTTPS.");
  process.exit(1);
}
if (!/^[a-f0-9-]{16,64}$/i.test(env.INSTALLATION_ID!)) {
  console.error("[custom-domain] INSTALLATION_ID is invalid.");
  process.exit(1);
}

const baseUrl = env.CONTROL_PLANE_URL!.replace(/\/+$/, "");
const controlResponse = await fetch(
  baseUrl + "/api/installations/" + encodeURIComponent(env.INSTALLATION_ID!) + "/dns-requirements",
  { headers: { Authorization: "Bearer " + env.CONTROL_PLANE_ADMIN_TOKEN!, Accept: "application/json" }, redirect: "error" }
);
if (!controlResponse.ok) {
  console.error("[custom-domain] Control plane rejected installation request (" + controlResponse.status + ").");
  process.exit(1);
}
const manifest = await controlResponse.json() as { domain?: string; workerName?: string; accountId?: string; zoneId?: string };
if (typeof manifest.domain !== "string" ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(manifest.domain) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(manifest.workerName || "") ||
    !/^[a-f0-9]{32}$/i.test(manifest.accountId || "") ||
    !/^[a-f0-9]{32}$/i.test(manifest.zoneId || "")) {
  console.error("[custom-domain] Installation manifest is incomplete or invalid.");
  process.exit(1);
}
const hostname = "mail." + manifest.domain.toLowerCase();
const api = "https://api.cloudflare.com/client/v4";
const headers = { Authorization: "Bearer " + env.CLOUDFLARE_API_TOKEN!, Accept: "application/json" };
async function read<T>(path: string): Promise<T> {
  const response = await fetch(api + path, { headers, redirect: "error" });
  const payload = await response.json().catch(() => null) as { success?: boolean; result?: T } | null;
  if (!response.ok || !payload?.success || payload.result === undefined) {
    throw new Error("Cloudflare read failed (" + response.status + ") for " + path + ".");
  }
  return payload.result;
}
// The Workers Scripts list endpoint returns the account's uploaded scripts as one result array.
const workers = await read<Array<{ id?: string }>>(
  "/accounts/" + manifest.accountId + "/workers/scripts"
);
const workerFound = workers.some(item => item.id === manifest.workerName);
if (!workerFound) {
  console.error("[custom-domain] Destination Worker was not found in the account. Deploy it first; no domain was attached.");
  process.exit(1);
}
const domains = await read<WorkerDomainState[]>("/accounts/" + manifest.accountId + "/workers/domains?hostname=" + encodeURIComponent(hostname));
const current = domains.find(item => String(item.hostname || "").toLowerCase() === hostname) || null;
const dnsRecords: Array<{ type?: string; name?: string }> = [];
for (let page = 1; page <= 20; page++) {
  const batch = await read<Array<{ type?: string; name?: string }>>(
    "/zones/" + manifest.zoneId + "/dns_records?per_page=100&page=" + page
  );
  dnsRecords.push(...batch);
  if (batch.length < 100) break;
  if (page === 20) throw new Error("More than 2,000 DNS records; refusing an incomplete conflict check.");
}
const routes = await read<Array<{ id?: string; pattern?: string; script?: string }>>(
  "/zones/" + manifest.zoneId + "/workers/routes"
);
const decision = assessWorkerDomain(current, hostname, manifest.workerName!, manifest.zoneId!);
const dnsConflict = hasDnsConflictForCustomDomain(hostname, dnsRecords);
const routeConflict = hasWorkerRouteConflict(hostname, routes);
console.log("Custom Domain preflight");
console.log("Hostname: " + hostname);
console.log("Worker: " + manifest.workerName);
console.log("Attachment: " + decision.toUpperCase());
console.log("Existing DNS at hostname: " + (dnsConflict ? "CONFLICT" : "none"));
console.log("Overlapping Worker route: " + (routeConflict ? "CONFLICT" : "none"));
if (routeConflict) {
  console.error("[custom-domain] An existing Worker route overlaps this hostname. It will not be changed.");
  process.exit(2);
}
if (decision === "already_configured") {
  console.log("[custom-domain] Already attached to the intended Worker. No changes needed.");
  process.exit(0);
}
if (decision === "conflict" || dnsConflict) {
  console.error("[custom-domain] Conflict detected. Existing routing or DNS will not be modified.");
  process.exit(2);
}
console.log("Action: attach a Cloudflare Custom Domain; Cloudflare will create the required DNS record and issue TLS.");
console.log("No changes have been made.");
if (!applying) {
  console.log("Review this plan, then run npm run setup:custom-domain -- --apply to apply with explicit confirmation.");
  process.exit(0);
}
const rl = createInterface({ input: stdin, output: stdout });
let confirmation = "";
try {
  confirmation = await rl.question("Type the exact hostname to attach this Worker Custom Domain: ");
} finally {
  rl.close();
}
if (confirmation.trim().toLowerCase() !== hostname) {
  console.log("[custom-domain] Confirmation did not match. No changes were made.");
  process.exit(2);
}
// Re-read immediately before the write to reduce the chance of taking over a hostname changed after preflight.
const latestDomains = await read<WorkerDomainState[]>("/accounts/" + manifest.accountId + "/workers/domains?hostname=" + encodeURIComponent(hostname));
const latest = latestDomains.find(item => String(item.hostname || "").toLowerCase() === hostname) || null;
const latestDns: Array<{ type?: string; name?: string }> = [];
for (let page = 1; page <= 20; page++) {
  const batch = await read<Array<{ type?: string; name?: string }>>(
    "/zones/" + manifest.zoneId + "/dns_records?per_page=100&page=" + page
  );
  latestDns.push(...batch);
  if (batch.length < 100) break;
  if (page === 20) throw new Error("More than 2,000 DNS records; refusing to apply with an incomplete conflict check.");
}
const latestDecision = assessWorkerDomain(latest, hostname, manifest.workerName!, manifest.zoneId!);
const latestRoutes = await read<Array<{ id?: string; pattern?: string; script?: string }>>(
  "/zones/" + manifest.zoneId + "/workers/routes"
);
if (latestDecision !== "create" || hasDnsConflictForCustomDomain(hostname, latestDns) || hasWorkerRouteConflict(hostname, latestRoutes)) {
  console.error("[custom-domain] The hostname changed after preflight. Refusing to attach it.");
  process.exit(2);
}
const response = await fetch(api + "/accounts/" + manifest.accountId + "/workers/domains", {
  method: "PUT",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({
    hostname,
    service: manifest.workerName,
    enabled: true,
    previews_enabled: false,
    zone_id: manifest.zoneId,
    zone_name: manifest.domain
  }),
  redirect: "error"
});
const payload = await response.json().catch(() => null) as { success?: boolean; result?: WorkerDomainState } | null;
if (!response.ok || !payload?.success || payload.result?.hostname?.toLowerCase() !== hostname ||
    payload.result?.service !== manifest.workerName || payload.result?.enabled !== true) {
  console.error("[custom-domain] Cloudflare did not confirm the expected attachment (" + response.status + "). Inspect the zone before retrying.");
  process.exit(1);
}
console.log("[custom-domain] Custom Domain attached and verified for " + hostname + ".");
