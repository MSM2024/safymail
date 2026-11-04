import { buildDnsPlan, type RequiredDnsRecord, type ExistingDnsRecord } from "../src/provisioning/dns-plan";

const env = process.env;
const required = ["CONTROL_PLANE_URL", "CONTROL_PLANE_ADMIN_TOKEN", "INSTALLATION_ID", "CLOUDFLARE_API_TOKEN"];
for (const key of required) {
  if (!env[key]?.trim()) {
    console.error("[dns-plan] Missing environment variable: " + key + ".");
    process.exit(1);
  }
}
if (!/^https:\/\//i.test(env.CONTROL_PLANE_URL!)) {
  console.error("[dns-plan] CONTROL_PLANE_URL must use HTTPS.");
  process.exit(1);
}
if (!/^[a-f0-9-]{16,64}$/i.test(env.INSTALLATION_ID!)) {
  console.error("[dns-plan] INSTALLATION_ID is invalid.");
  process.exit(1);
}

const baseUrl = env.CONTROL_PLANE_URL!.replace(/\/+$/, "");
const controlResponse = await fetch(
  baseUrl + "/api/installations/" + encodeURIComponent(env.INSTALLATION_ID!) + "/dns-requirements",
  { headers: { Authorization: "Bearer " + env.CONTROL_PLANE_ADMIN_TOKEN!, Accept: "application/json" }, redirect: "error" }
);
if (!controlResponse.ok) {
  console.error("[dns-plan] Control plane rejected DNS requirements request (" + controlResponse.status + ").");
  process.exit(1);
}
const requirements = await controlResponse.json() as {
  domain?: string;
  zoneId?: string;
  records?: RequiredDnsRecord[];
};
if (typeof requirements.domain !== "string" ||
    !/^[a-f0-9]{32}$/i.test(requirements.zoneId || "") ||
    !Array.isArray(requirements.records) ||
    requirements.records.length > 100) {
  console.error("[dns-plan] DNS requirements are incomplete or invalid.");
  process.exit(1);
}

const cloudflareBase = "https://api.cloudflare.com/client/v4/zones/" + requirements.zoneId + "/dns_records";
const existing: ExistingDnsRecord[] = [];
for (let page = 1; page <= 20; page++) {
  const response = await fetch(cloudflareBase + "?per_page=100&page=" + page, {
    headers: { Authorization: "Bearer " + env.CLOUDFLARE_API_TOKEN!, Accept: "application/json" },
    redirect: "error"
  });
  const payload = await response.json().catch(() => null) as {
    success?: boolean;
    errors?: Array<{ message?: string }>;
    result?: Array<{ type?: string; name?: string; content?: string; priority?: number | null }>;
  } | null;
  if (!response.ok || !payload?.success || !Array.isArray(payload.result)) {
    console.error("[dns-plan] Cloudflare DNS query failed on page " + page + ". No DNS changes were made.");
    process.exit(1);
  }
  for (const record of payload.result) {
    if (typeof record.type === "string" && typeof record.name === "string" && typeof record.content === "string") {
      existing.push({ type: record.type, name: record.name, content: record.content, priority: record.priority });
    }
  }
  if (payload.result.length < 100) break;
  if (page === 20) {
    console.error("[dns-plan] More than 2,000 DNS records were returned. Cannot guarantee a complete conflict check; no changes were made.");
    process.exit(1);
  }
}

const plan = buildDnsPlan(requirements.domain, requirements.records, existing);
console.log("DNS preflight for " + requirements.domain + " (Resend outbound records only)");
console.log("No DNS records were created, modified or deleted.\n");
for (const item of plan) {
  const label = item.action.toUpperCase().padEnd(7);
  console.log(label + " " + item.type.padEnd(6) + " " + item.name);
  if (item.action === "manual") {
    console.log("        " + item.reason);
  } else if (item.action === "create") {
    console.log("        Value: " + item.content);
    console.log("        TTL: " + (item.ttl === 1 ? "Auto" : item.ttl) +
      (item.priority === undefined ? "" : " | Priority: " + item.priority));
  }
}
const manual = plan.filter(item => item.action === "manual").length;
const create = plan.filter(item => item.action === "create").length;
const present = plan.filter(item => item.action === "present").length;
console.log("\nSummary: " + present + " already correct, " + create + " missing, " + manual + " require manual reconciliation.");
if (manual) process.exitCode = 2;
