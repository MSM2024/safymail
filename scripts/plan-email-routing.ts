import { buildDnsPlan, type RequiredDnsRecord, type ExistingDnsRecord } from "../src/provisioning/dns-plan";
import { assessCatchAll } from "../src/provisioning/email-routing-plan";

const env = process.env;
for (const key of ["CONTROL_PLANE_URL", "CONTROL_PLANE_ADMIN_TOKEN", "INSTALLATION_ID", "CLOUDFLARE_API_TOKEN"]) {
  if (!env[key]?.trim()) {
    console.error("[email-routing] Missing environment variable: " + key + ".");
    process.exit(1);
  }
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
  console.error("[email-routing] Control plane rejected requirements request (" + manifestResponse.status + ").");
  process.exit(1);
}
const manifest = await manifestResponse.json() as { domain?: string; workerName?: string; zoneId?: string; records?: RequiredDnsRecord[] };
if (typeof manifest.domain !== "string" || typeof manifest.workerName !== "string" ||
    !/^[a-f0-9]{32}$/i.test(manifest.zoneId || "") || !Array.isArray(manifest.records)) {
  console.error("[email-routing] Installation manifest is incomplete.");
  process.exit(1);
}

const headers = { Authorization: "Bearer " + env.CLOUDFLARE_API_TOKEN!, Accept: "application/json" };
const zoneApi = "https://api.cloudflare.com/client/v4/zones/" + manifest.zoneId;
async function getResult<T>(path: string): Promise<T> {
  const response = await fetch(zoneApi + path, { headers, redirect: "error" });
  const payload = await response.json().catch(() => null) as { success?: boolean; result?: T } | null;
  if (!response.ok || !payload?.success || payload.result === undefined) {
    throw new Error("Cloudflare read failed for " + path + " (" + response.status + ").");
  }
  return payload.result;
}

let settings: { enabled?: boolean; status?: string; name?: string } = {};
let emailDns: Array<{ type?: string; name?: string; content?: string; ttl?: number; priority?: number }> = [];
type RoutingRule = {
  id?: string;
  enabled?: boolean;
  actions?: Array<{ type?: string; value?: string[] }>;
  matchers?: Array<{ type?: string; field?: string; value?: string }>;
};
let catchAll: RoutingRule | null = null;
try {
  settings = await getResult("/email/routing");
  emailDns = await getResult("/email/routing/dns");
  const catchPath = zoneApi + "/email/routing/rules/catch_all";
  const catchResponse = await fetch(catchPath, { headers, redirect: "error" });
  const catchPayload = await catchResponse.json().catch(() => null) as { success?: boolean; result?: RoutingRule } | null;
  if (catchResponse.ok && catchPayload?.success && catchPayload.result) {
    catchAll = catchPayload.result;
  } else if (catchResponse.status === 404) {
    const listedRules: RoutingRule[] = [];
    for (let page = 1; page <= 20; page++) {
      const listed = await fetch(zoneApi + "/email/routing/rules?per_page=100&page=" + page, { headers, redirect: "error" });
      const listPayload = await listed.json().catch(() => null) as { success?: boolean; result?: RoutingRule[] } | null;
      if (!listed.ok || !listPayload?.success || !Array.isArray(listPayload.result)) {
        throw new Error("Could not inspect existing Email Routing rules (" + listed.status + ").");
      }
      listedRules.push(...listPayload.result);
      if (listPayload.result.length < 100) break;
      if (page === 20) throw new Error("More than 2,000 Email Routing rules; refusing an incomplete conflict check.");
    }
    const allRules = listedRules.filter(rule => rule.matchers?.some(matcher => matcher.type === "all"));
    if (allRules.length > 1) {
      catchAll = { enabled: true, actions: [{ type: "conflict" }] };
    } else if (allRules.length === 1) {
      catchAll = allRules[0];
    }
  } else {
    throw new Error("Could not inspect the Email Routing catch-all rule (" + catchResponse.status + ").");
  }
} catch (error) {
  console.error("[email-routing] " + (error instanceof Error ? error.message : "Cloudflare preflight failed.") + " No changes were made.");
  process.exit(1);
}

const existing: ExistingDnsRecord[] = [];
for (let page = 1; page <= 20; page++) {
  const response = await fetch(zoneApi + "/dns_records?per_page=100&page=" + page, { headers, redirect: "error" });
  const payload = await response.json().catch(() => null) as {
    success?: boolean;
    result?: Array<{ type?: string; name?: string; content?: string; priority?: number | null }>;
  } | null;
  if (!response.ok || !payload?.success || !Array.isArray(payload.result)) {
    console.error("[email-routing] Could not list DNS records completely. No changes were made.");
    process.exit(1);
  }
  for (const record of payload.result) {
    if (typeof record.type === "string" && typeof record.name === "string" && typeof record.content === "string") {
      existing.push({ type: record.type, name: record.name, content: record.content, priority: record.priority });
    }
  }
  if (payload.result.length < 100) break;
  if (page === 20) {
    console.error("[email-routing] More than 2,000 DNS records; refusing an incomplete conflict check.");
    process.exit(1);
  }
}

const requiredDns: RequiredDnsRecord[] = (emailDns || []).flatMap(record =>
  typeof record.type === "string" && typeof record.name === "string" && typeof record.content === "string"
    ? [{ type: record.type, name: record.name, value: record.content, ttl: record.ttl, priority: record.priority }]
    : []
);
const plan = buildDnsPlan(manifest.domain, requiredDns, existing);
console.log("Cloudflare Email Routing preflight: " + manifest.domain);
console.log("Settings: " + (settings.enabled ? "enabled" : "disabled") + " | status: " + (settings.status || "unknown"));
console.log("Required Email Routing DNS records:");
for (const item of plan) {
  console.log("  " + item.action.toUpperCase().padEnd(7) + " " + item.type + " " + item.name +
    (item.action === "manual" ? " — " + item.reason : item.action === "create" ? " — " + item.content : ""));
}
const catchAllDecision = assessCatchAll(catchAll, manifest.workerName);
if (catchAllDecision === "already_configured") {
  console.log("Catch-all: already enabled for Worker " + manifest.workerName + ".");
} else if (catchAllDecision === "conflict") {
  console.log("Catch-all: CONFLICT — a non-default catch-all action exists. It will not be replaced.");
} else if (catchAll) {
  console.log("Catch-all: disabled default drop rule; a separately confirmed operation can enable it for the Worker.");
} else {
  console.log("Catch-all: no all-recipient rule exists; a separately confirmed rule can be created after DNS is ready.");
}
console.log("No Email Routing settings, rules or DNS records were changed.");
if (plan.some(item => item.action === "manual") || catchAllDecision === "conflict") process.exitCode = 2;
