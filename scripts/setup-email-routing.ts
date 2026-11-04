import { assessCatchAll } from "../src/provisioning/email-routing-plan";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const env = process.env;
for (const key of ["CONTROL_PLANE_URL", "CONTROL_PLANE_ADMIN_TOKEN", "INSTALLATION_ID", "CLOUDFLARE_API_TOKEN"]) {
  if (!env[key]?.trim()) {
    console.error("[email-routing] Missing environment variable: " + key + ".");
    process.exit(1);
  }
}
if (!process.argv.includes("--apply")) {
  console.error("[email-routing] This command changes the domain catch-all route. Review `npm run plan:email-routing` first, then rerun with --apply.");
  process.exit(2);
}
if (!stdin.isTTY || !stdout.isTTY) {
  console.error("[email-routing] Interactive terminal confirmation is required. No routing rule was changed.");
  process.exit(1);
}
if (!/^https:\/\//i.test(env.CONTROL_PLANE_URL!)) {
  console.error("[email-routing] CONTROL_PLANE_URL must use HTTPS.");
  process.exit(1);
}
if (!/^[a-f0-9-]{16,64}$/i.test(env.INSTALLATION_ID!)) {
  console.error("[email-routing] INSTALLATION_ID is invalid.");
  process.exit(1);
}

const baseUrl = env.CONTROL_PLANE_URL!.replace(/\/+$/, "");
const manifestResponse = await fetch(
  baseUrl + "/api/installations/" + encodeURIComponent(env.INSTALLATION_ID!) + "/dns-requirements",
  { headers: { Authorization: "Bearer " + env.CONTROL_PLANE_ADMIN_TOKEN!, Accept: "application/json" }, redirect: "error" }
);
if (!manifestResponse.ok) {
  console.error("[email-routing] Control plane rejected installation request (" + manifestResponse.status + ").");
  process.exit(1);
}
const manifest = await manifestResponse.json() as { domain?: string; workerName?: string; accountId?: string; zoneId?: string };
if (typeof manifest.domain !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(manifest.domain) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(manifest.workerName || "") ||
    !/^[a-f0-9]{32}$/i.test(manifest.accountId || "") ||
    !/^[a-f0-9]{32}$/i.test(manifest.zoneId || "")) {
  console.error("[email-routing] Installation manifest is incomplete or invalid.");
  process.exit(1);
}

const api = "https://api.cloudflare.com/client/v4";
const headers = { Authorization: "Bearer " + env.CLOUDFLARE_API_TOKEN!, Accept: "application/json" };
async function request<T>(path: string, init: RequestInit = {}): Promise<{ response: Response; result: T | null }> {
  const response = await fetch(api + path, { ...init, headers: { ...headers, ...init.headers }, redirect: "error" });
  const payload = await response.json().catch(() => null) as { success?: boolean; result?: T } | null;
  return { response, result: payload?.success ? payload.result ?? null : null };
}
const settingsPath = "/zones/" + manifest.zoneId + "/email/routing";
const settings = await request<{ enabled?: boolean; status?: string }>(settingsPath);
if (!settings.response.ok || !settings.result) {
  console.error("[email-routing] Cannot read Email Routing settings. Check Zone Settings Read permission.");
  process.exit(1);
}
if (settings.result.enabled !== true || settings.result.status !== "ready") {
  console.error("[email-routing] Email Routing is not enabled and ready. Review/apply its DNS records and enable it in Cloudflare first. No routing rule was changed.");
  process.exit(2);
}

const workers = await request<Array<{ id?: string }>>(
  "/accounts/" + manifest.accountId + "/workers/scripts"
);
if (!workers.response.ok || !workers.result?.some(item => item.id === manifest.workerName)) {
  console.error("[email-routing] The destination Worker could not be verified. Check Workers Scripts Read permission and deploy the Worker first.");
  process.exit(1);
}

const catchPath = "/zones/" + manifest.zoneId + "/email/routing/rules/catch_all";
type RoutingRule = {
  id?: string;
  enabled?: boolean;
  actions?: Array<{ type?: string; value?: string[] }>;
  matchers?: Array<{ type?: string; field?: string; value?: string }>;
};
type CatchAllTarget = {
  kind: "catch_all" | "rule" | "none";
  rule: RoutingRule | null;
  decision: "already_configured" | "create" | "conflict";
};
async function listRoutingRules(): Promise<RoutingRule[]> {
  const rules: RoutingRule[] = [];
  const rulesPath = "/zones/" + manifest.zoneId + "/email/routing/rules";
  for (let page = 1; page <= 20; page++) {
    const listed = await request<RoutingRule[]>(rulesPath + "?per_page=100&page=" + page);
    if (!listed.response.ok || !Array.isArray(listed.result)) {
      throw new Error("Could not completely inspect Email Routing rules (" + listed.response.status + ").");
    }
    rules.push(...listed.result);
    if (listed.result.length < 100) return rules;
  }
  throw new Error("More than 2,000 Email Routing rules; refusing an incomplete conflict check.");
}
async function inspectCatchAll(): Promise<CatchAllTarget> {
  const special = await request<RoutingRule>(catchPath);
  if (special.response.ok && special.result) {
    return { kind: "catch_all", rule: special.result, decision: assessCatchAll(special.result, manifest.workerName!) };
  }
  if (special.response.status !== 404) {
    throw new Error("Could not safely inspect the catch-all rule (" + special.response.status + ").");
  }
  const rules = await listRoutingRules();
  const allRules = rules.filter(rule => rule.matchers?.some(matcher => matcher.type === "all"));
  if (allRules.length > 1) return { kind: "rule", rule: null, decision: "conflict" };
  if (allRules.length === 0) return { kind: "none", rule: null, decision: "create" };
  const rule = allRules[0];
  if (!rule.id) return { kind: "rule", rule, decision: "conflict" };
  return { kind: "rule", rule, decision: assessCatchAll(rule, manifest.workerName!) };
}
let target: CatchAllTarget;
try {
  target = await inspectCatchAll();
} catch (error) {
  console.error("[email-routing] " + (error instanceof Error ? error.message : "Could not inspect routing rules.") + " No changes were made.");
  process.exit(1);
}
if (target.decision === "already_configured") {
  console.log("[email-routing] Catch-all is already enabled for " + manifest.workerName + ". No changes needed.");
  process.exit(0);
}
if (target.decision === "conflict") {
  console.error("[email-routing] An existing all-recipient rule is ambiguous or has a non-default action. It will not be replaced.");
  process.exit(2);
}

console.log("Domain: " + manifest.domain);
console.log("Worker destination: " + manifest.workerName);
console.log("Action: " + (target.kind === "none" ? "create a new all-recipient Email Routing rule" : "enable the existing disabled default-drop rule") + ".");
console.log("No DNS records or existing non-default routing rules will be modified.");
const rl = createInterface({ input: stdin, output: stdout });
let confirmation = "";
try {
  confirmation = await rl.question("Type the exact domain name to configure this mail route: ");
} finally {
  rl.close();
}
if (confirmation.trim().toLowerCase() !== manifest.domain.toLowerCase()) {
  console.log("[email-routing] Confirmation did not match. No routing rule was changed.");
  process.exit(2);
}

// Re-read immediately before the write; do not act on a rule changed during confirmation.
let latest: CatchAllTarget;
try {
  latest = await inspectCatchAll();
} catch (error) {
  console.error("[email-routing] " + (error instanceof Error ? error.message : "Could not re-check routing rules.") + " No changes were made.");
  process.exit(1);
}
if (latest.decision === "already_configured") {
  console.log("[email-routing] The route was configured while awaiting confirmation. No changes needed.");
  process.exit(0);
}
if (latest.decision !== "create" || latest.kind !== target.kind ||
    (latest.kind === "rule" && latest.rule?.id !== target.rule?.id)) {
  console.error("[email-routing] The routing configuration changed after preflight. Refusing to overwrite it.");
  process.exit(2);
}

const writePath = target.kind === "catch_all"
  ? catchPath
  : target.kind === "rule"
    ? "/zones/" + manifest.zoneId + "/email/routing/rules/" + encodeURIComponent(target.rule!.id!)
    : "/zones/" + manifest.zoneId + "/email/routing/rules";
const writeMethod = target.kind === "none" ? "POST" : "PUT";
const created = await request<RoutingRule>(writePath, {
  method: writeMethod,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    actions: [{ type: "worker", value: [manifest.workerName] }],
    enabled: true,
    matchers: [{ type: "all" }],
    name: "Mail Center catch-all for " + manifest.domain,
    source: "api"
  })
});
if (!created.response.ok || !created.result?.enabled ||
    !created.result.actions?.some(action => action.type === "worker" && action.value?.includes(manifest.workerName!))) {
  console.error("[email-routing] Cloudflare did not confirm the requested all-recipient Worker rule (" + created.response.status + "). Inspect the zone before retrying.");
  process.exit(1);
}
console.log("[email-routing] All-recipient Email Routing rule created/updated and verified for " + manifest.workerName + ".");
