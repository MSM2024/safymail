import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = path.resolve(process.argv[2] || path.join(root, "installation.json"));
const templatePath = path.join(root, "wrangler.template.toml");
const outputPath = path.join(root, "wrangler.toml");

function fail(message) {
  console.error("[configuration] " + message);
  process.exit(1);
}
function requiredString(value, label, max = 120) {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail(label + " is required and must be at most " + max + " characters.");
  return value.trim();
}
function toml(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\" + '"');
}

if (!fs.existsSync(inputPath)) {
  fail("Configuration not found: " + path.relative(root, inputPath) + ". Copy installation.example.json to installation.json and fill in the installation values.");
}
const config = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const appName = requiredString(config.appName, "appName");
const workerName = requiredString(config.workerName, "workerName", 63).toLowerCase();
const environment = requiredString(config.environment || "production", "environment", 32);
const domain = requiredString(config.domain, "domain", 253).toLowerCase();
const adminEmail = requiredString(config.adminEmail, "adminEmail", 254).toLowerCase();
const region = requiredString(config.resendRegion || "eu-west-1", "resendRegion", 32);
const controlPlaneUrl = requiredString(config.controlPlaneUrl, "controlPlaneUrl", 2048);
const installationId = requiredString(config.installationId, "installationId", 64);
try { const u=new URL(controlPlaneUrl); if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash) fail("controlPlaneUrl must be a trusted HTTPS URL."); } catch { fail("controlPlaneUrl must be a valid HTTPS URL."); }
if(!/^[a-f0-9-]{16,64}$/i.test(installationId)) fail("installationId is invalid.");
if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workerName)) fail("workerName must be a valid Cloudflare Worker slug.");
if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) fail("domain is not a valid hostname.");
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) fail("adminEmail is not a valid email address.");
if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) fail("resendRegion must be a valid region identifier such as eu-west-1.");

const accountId = requiredString(config.cloudflare?.accountId, "cloudflare.accountId", 64);
const zoneId = requiredString(config.cloudflare?.zoneId, "cloudflare.zoneId", 64);
const d1Name = requiredString(config.resources?.d1DatabaseName, "resources.d1DatabaseName", 63);
const d1Id = requiredString(config.resources?.d1DatabaseId, "resources.d1DatabaseId", 64);
const kvId = requiredString(config.resources?.kvNamespaceId, "resources.kvNamespaceId", 64);
if (!/^[a-f0-9]{32}$/i.test(accountId)) fail("cloudflare.accountId must be a 32-character hexadecimal ID.");
if (!/^[a-f0-9]{32}$/i.test(zoneId)) fail("cloudflare.zoneId must be a 32-character hexadecimal Cloudflare zone ID.");
if (!/^[a-f0-9-]{36}$/i.test(d1Id)) fail("resources.d1DatabaseId must be a UUID-like D1 ID.");
if (!/^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/i.test(d1Name)) fail("resources.d1DatabaseName must be a valid D1 database name.");
if (!/^[a-f0-9]{32}$/i.test(kvId)) fail("resources.kvNamespaceId must be a 32-character hexadecimal KV ID.");
if (["4f618dfc-9f9c-444e-8162-4d4448525cf5", "a4c7fbe5-7561-445c-baf1-039d720f4904"].includes(d1Id.toLowerCase())) {
  fail("This D1 ID belongs to the original Europe Mail Center environments and cannot be used by the generic template.");
}
if (["1fdbced897a74281a216dcaeaa08081c", "e834809ce2954a00aae073568a9c7ad0"].includes(kvId.toLowerCase())) {
  fail("This KV ID belongs to the original Europe Mail Center environments and cannot be used by the generic template.");
}

const template = fs.readFileSync(templatePath, "utf8");
const values = {
  WORKER_NAME: workerName,
  ACCOUNT_ID: accountId,
  D1_DATABASE_NAME: d1Name,
  D1_DATABASE_ID: d1Id,
  KV_NAMESPACE_ID: kvId,
  APP_NAME: appName,
  ENVIRONMENT: environment,
  RESEND_REGION: region,
  CONTROL_PLANE_URL: controlPlaneUrl.replace(/\/+$/, ""),
  INSTALLATION_ID: installationId
};
let output = template;
for (const [key, value] of Object.entries(values)) {
  output = output.replaceAll("{{" + key + "}}", toml(value));
}
const unresolved = output.match(/\{\{[A-Z_]+\}\}/g);
if (unresolved) fail("Unresolved template values: " + unresolved.join(", "));
fs.writeFileSync(outputPath, output, { mode: 0o600 });
console.log("Generated wrangler.toml for " + appName + ".");
console.log("Domain: " + domain + " | Admin: " + adminEmail);
console.log("Cloudflare account and zone IDs were validated; no credentials were read or written.");
console.log("The generated file is ignored by Git. Do not commit it.");
