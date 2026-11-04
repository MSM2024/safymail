import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = "mailme.msmmystore.com";
const worker = "msm-mail-preview";
const zone = "msmmystore.com";
const apply = process.argv.includes("--apply");
const token = process.env.CLOUDFLARE_API_TOKEN || "";
if (!token || token.length < 20) {
  console.error("[mailme] Set CLOUDFLARE_API_TOKEN in your private terminal session. Never paste it into GitHub or chat.");
  process.exit(2);
}
const config = fs.existsSync(path.join(root,"wrangler.toml"))
  ? fs.readFileSync(path.join(root,"wrangler.toml"),"utf8") : "";
const accountId=(/^\s*account_id\s*=\s*["']([0-9a-f]{32})["']/mi.exec(config)||[])[1]
  || process.env.CLOUDFLARE_ACCOUNT_ID || "";
if (!/^[0-9a-f]{32}$/i.test(accountId)) {
  console.error("[mailme] No valid Cloudflare account ID in wrangler.toml or CLOUDFLARE_ACCOUNT_ID.");
  process.exit(2);
}
const base="https://api.cloudflare.com/client/v4";
async function cloudflare(method,url,body) {
  const res=await fetch(base+url,{
    method,
    headers:{Authorization:"Bearer "+token,Accept:"application/json",...(body?{"Content-Type":"application/json"}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),
    redirect:"error",
    signal:AbortSignal.timeout(20000)
  });
  const result=await res.json().catch(()=>null);
  if(!res.ok||!result?.success){
    const codes=(result?.errors||[]).map(e=>e.code).filter(Boolean).join(",");
    throw Error("Cloudflare "+method+" "+url.split("?")[0]+" failed (HTTP "+res.status+(codes?", codes "+codes:"")+")");
  }
  return result.result;
}
const zones=await cloudflare("GET","/zones?name="+encodeURIComponent(zone)+"&per_page=50");
const found=(zones||[]).filter(v=>v.name===zone&&v.status==="active"&&v.account?.id===accountId);
if(found.length!==1)throw Error("Active zone for this account was not uniquely confirmed; no changes made.");
const zoneId=found[0].id;
const scripts=await cloudflare("GET","/accounts/"+accountId+"/workers/scripts");
if(!Array.isArray(scripts)||!scripts.some(v=>v.id===worker)){
  throw Error("Target Worker "+worker+" not found in this account; no changes made.");
}
const configured=await cloudflare("GET","/accounts/"+accountId+"/workers/domains");
const attached=(configured||[]).filter(v=>v.hostname===target);
if(attached.length){
  if(attached.length===1&&attached[0].service===worker&&attached[0].zone_id===zoneId){
    console.log("[mailme] Existing custom domain is already attached to "+worker+". enabled="+Boolean(attached[0].enabled));
    process.exit(0);
  }
  throw Error("Hostname is already attached to another Worker or zone; no changes made.");
}
const existingDns=await cloudflare("GET","/zones/"+zoneId+"/dns_records?name="+encodeURIComponent(target)+"&per_page=100");
if((existingDns||[]).length) {
  console.error("[mailme] Existing DNS records for "+target+": "+existingDns.map(v=>v.type).join(", "));
  throw Error("Manual DNS collision review required. Never overwrite DNS records automatically.");
}
console.log("[mailme] Preflight PASS: owned zone, target Worker present, no conflicting DNS, no existing Worker custom domain.");
console.log("[mailme] Domain: "+target+" -> "+worker);
if(!apply){
  console.log("[mailme] DRY RUN: no Cloudflare data changed. Re-run with --apply to attach.");
  process.exit(0);
}
const response=await cloudflare("PUT","/accounts/"+accountId+"/workers/domains",{
  hostname:target,service:worker,zone_id:zoneId,environment:"production"
});
if(response?.hostname!==target||response?.service!==worker||response?.zone_id!==zoneId){
  throw Error("Cloudflare accepted the request but returned an unexpected binding. Verify manually.");
}
console.log("[mailme] Cloudflare accepted custom domain attachment. enabled="+Boolean(response.enabled));
console.log("[mailme] TLS certificate/DNS propagation and login readiness must still be checked.");
