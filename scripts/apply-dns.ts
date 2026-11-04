import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { buildDnsPlan, type RequiredDnsRecord, type ExistingDnsRecord } from "../src/provisioning/dns-plan";

const env = process.env;
const required = ["CONTROL_PLANE_URL", "CONTROL_PLANE_ADMIN_TOKEN", "INSTALLATION_ID", "CLOUDFLARE_API_TOKEN"];
for (const key of required) {
  if (!env[key]?.trim()) {
    console.error("[dns-apply] Missing environment variable: " + key + ".");
    process.exit(1);
  }
}
if (!process.argv.includes("--apply")) {
  console.error("[dns-apply] This command makes DNS changes. Re-run with --apply after reviewing `npm run plan:dns`.");
  process.exit(2);
}
if (!stdin.isTTY || !stdout.isTTY) {
  console.error("[dns-apply] Interactive terminal confirmation is required. No DNS changes were made.");
  process.exit(1);
}
if (!/^https:\/\//i.test(env.CONTROL_PLANE_URL!)) {
  console.error("[dns-apply] CONTROL_PLANE_URL must use HTTPS.");
  process.exit(1);
}
if (!/^[a-f0-9-]{16,64}$/i.test(env.INSTALLATION_ID!)) {
  console.error("[dns-apply] INSTALLATION_ID is invalid.");
  process.exit(1);
}

const baseUrl = env.CONTROL_PLANE_URL!.replace(/\/+$/, "");
const controlResponse = await fetch(
  baseUrl + "/api/installations/" + encodeURIComponent(env.INSTALLATION_ID!) + "/dns-requirements",
  { headers: { Authorization: "Bearer " + env.CONTROL_PLANE_ADMIN_TOKEN!, Accept: "application/json" }, redirect: "error" }
);
if (!controlResponse.ok) {
  console.error("[dns-apply] Control plane rejected DNS requirements request (" + controlResponse.status + ").");
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
  console.error("[dns-apply] DNS requirements are incomplete or invalid.");
  process.exit(1);
}

const endpoint = "https://api.cloudflare.com/client/v4/zones/" + requirements.zoneId + "/dns_records";
const existing: ExistingDnsRecord[] = [];
for (let page = 1; page <= 20; page++) {
  const response = await fetch(endpoint + "?per_page=100&page=" + page, {
    headers: { Authorization: "Bearer " + env.CLOUDFLARE_API_TOKEN!, Accept: "application/json" },
    redirect: "error"
  });
  const payload = await response.json().catch(() => null) as {
    success?: boolean;
    result?: Array<{ type?: string; name?: string; content?: string; priority?: number | null }>;
  } | null;
  if (!response.ok || !payload?.success || !Array.isArray(payload.result)) {
    console.error("[dns-apply] Cloudflare DNS query failed on page " + page + ". No DNS changes were made.");
    process.exit(1);
  }
  for (const record of payload.result) {
    if (typeof record.type === "string" && typeof record.name === "string" && typeof record.content === "string") {
      existing.push({ type: record.type, name: record.name, content: record.content, priority: record.priority });
    }
  }
  if (payload.result.length < 100) break;
  if (page === 20) {
    console.error("[dns-apply] More than 2,000 DNS records were returned. Cannot guarantee a complete conflict check; no changes were made.");
    process.exit(1);
  }
}

const plan = buildDnsPlan(requirements.domain, requirements.records, existing);
const conflicts = plan.filter(item => item.action === "manual");
if (conflicts.length) {
  console.error("[dns-apply] DNS conflicts require manual reconciliation. No records were created.");
  for (const item of conflicts) console.error(item.type + " " + item.name + ": " + item.reason);
  process.exit(2);
}
const missing = plan.filter(item => item.action === "create");
console.log("Domain: " + requirements.domain);
console.log("Already present: " + plan.filter(item => item.action === "present").length);
console.log("New records to create: " + missing.length);
for (const item of missing) {
  console.log("  " + item.type + " " + item.name + " -> " + item.content);
}
if (!missing.length) {
  console.log("[dns-apply] All Resend DNS records already exist. Nothing to do.");
  process.exit(0);
}

const rl = createInterface({ input: stdin, output: stdout });
let confirmation = "";
try {
  confirmation = await rl.question("Type the exact domain name to create only these missing records: ");
} finally {
  rl.close();
}
if (confirmation.trim().toLowerCase() !== requirements.domain.toLowerCase()) {
  console.log("[dns-apply] Confirmation did not match. No DNS changes were made.");
  process.exit(2);
}

for (const item of missing) {
  const body: Record<string, unknown> = {
    type: item.type,
    name: item.name,
    content: item.content,
    ttl: item.ttl
  };
  if (["A", "AAAA", "CNAME"].includes(item.type)) body.proxied = false;
  if (item.priority !== undefined) body.priority = item.priority;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.CLOUDFLARE_API_TOKEN!,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body),
    redirect: "error"
  });
  const payload = await response.json().catch(() => null) as { success?: boolean; errors?: Array<{ message?: string }> } | null;
  if (!response.ok || !payload?.success) {
    console.error("[dns-apply] Could not create " + item.type + " " + item.name + " (" + response.status + "). Earlier records may already have been created; rerun the planner before retrying.");
    process.exit(1);
  }
  console.log("[dns-apply] Created " + item.type + " " + item.name + ".");
}
console.log("[dns-apply] Missing Resend DNS records created. No existing record was changed or deleted.");
