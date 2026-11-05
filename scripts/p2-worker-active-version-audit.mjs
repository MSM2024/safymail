import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SCRIPT = "msm-mail-preview";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function extractAccountId(wranglerText) {
  const match = wranglerText.match(/^account_id\s*=\s*"([a-f0-9]{32})"\s*$/mi);
  if (!match) throw Error("Account ID not found in local wrangler.toml");
  const worker = wranglerText.match(/^name\s*=\s*"([^"]+)"\s*$/mi)?.[1];
  if (worker !== SCRIPT) throw Error("Unexpected Worker in wrangler.toml; no request made");
  return match[1];
}

export function classifyDeployments(response, expectedVersion) {
  if (!UUID.test(expectedVersion)) throw Error("Invalid expected Cloudflare Worker version ID");
  if (!Array.isArray(response) || !response.length) return {result:"no-deployments"};
  // Deployments are separate from uploaded versions. Prefer explicit creation
  // time instead of assuming API pagination order.
  const entries = response.filter(d => d && typeof d.created_on === "string" && !Number.isNaN(Date.parse(d.created_on)));
  if (!entries.length) return {result:"unreadable-deployments"};
  entries.sort((a,b) => Date.parse(b.created_on) - Date.parse(a.created_on));
  const latest=entries[0];
  if (!Array.isArray(latest.versions) || !latest.versions.length) return {result:"no-traffic-versions",deploymentCreated:latest.created_on};
  const traffic = latest.versions.map(v=>({
    version:typeof v.version_id==="string"&&UUID.test(v.version_id)?v.version_id:"invalid",
    percentage:typeof v.percentage==="number"?v.percentage:null
  }));
  const matching=traffic.length===1 && traffic[0].version===expectedVersion && traffic[0].percentage===100;
  return {
    result:matching?"expected-version-at-100-percent":"deployment-version-mismatch",
    deploymentCreated:latest.created_on,
    deployedVersions:traffic
  };
}

export async function readCloudflareDeployment(accountId, token, fetchFn = fetch) {
  if (!/^[a-f0-9]{32}$/i.test(accountId) || typeof token!=="string" || token.length<20)
    throw Error("Cloudflare account ID and private API token must be provided");
  const endpoint="https://api.cloudflare.com/client/v4/accounts/"+accountId+"/workers/scripts/"+SCRIPT+"/deployments?per_page=100";
  const res=await fetchFn(endpoint,{
    method:"GET",redirect:"error",headers:{Authorization:"Bearer "+token,Accept:"application/json"},
    signal:AbortSignal.timeout(16000)
  });
  if (!res.ok) throw Error("Cloudflare deployment read failed with HTTP "+res.status);
  const data=await res.json();
  if (data?.success!==true || !Array.isArray(data.result)) throw Error("Cloudflare returned an invalid deployment response");
  return data.result;
}

async function main() {
  const expected=process.argv[2];
  if(!expected || !UUID.test(expected)) {
    console.error("Usage: node scripts/p2-worker-active-version-audit.mjs <expected-version-uuid>");
    process.exitCode=2;return;
  }
  const token=process.env.CLOUDFLARE_API_TOKEN;
  if(!token) {
    console.error("P2-01 BLOCKED: set CLOUDFLARE_API_TOKEN in your private terminal; never share or print it.");
    process.exitCode=2;return;
  }
  const account=extractAccountId(readFileSync(path.join(ROOT,"wrangler.toml"),"utf8"));
  const deployments=await readCloudflareDeployment(account,token);
  const result=classifyDeployments(deployments,expected);
  console.log("P2 WORKER ACTIVE VERSION: "+JSON.stringify({worker:SCRIPT,expectedVersion:expected,...result}));
  console.log("Read-only Cloudflare deployment query; no Worker, Resend, DNS, D1 or credentials modified.");
  if(result.result!=="expected-version-at-100-percent") {
    console.error("P2-01 PENDING: version is not confirmed as 100% of the latest deployment.");
    process.exitCode=1;
  } else console.log("Current deployment reports the expected Worker version at 100% traffic; this is metadata attestation, not a downloaded bundle hash.");
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(err=>{console.error("P2-01 BLOCKED: "+(err instanceof Error?err.message:String(err)));process.exitCode=1;});
}
