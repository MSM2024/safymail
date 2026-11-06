import {pathToFileURL} from "node:url";

export const ORIGIN="https://mailme.msmmystore.com";
export const PUBLIC_ASSETS=Object.freeze([
  ["/", "text/html"],
  ["/admin", "text/html"],
  ["/admin.html", "text/html"],
  ["/msm-mail-ui.js", "javascript"],
  ["/msm-mail-ui.css", "text/css"],
  ["/msm-composer-r3.js", "javascript"],
  ["/api/health", "application/json"],
  ["/api/branding", "application/json"]
]);
export const PRIVATE_ENDPOINTS=Object.freeze([
  "/api/me","/api/accounts","/api/messages","/api/contacts","/api/notifications","/api/admin/companies"
]);
export function makeProbe(path){
  if(!PUBLIC_ASSETS.some(([p])=>p===path)&&!PRIVATE_ENDPOINTS.includes(path))
    throw Error("P4 probe is not approved");
  const url=new URL(path,ORIGIN);
  if(url.origin!==ORIGIN||url.pathname!==path||url.search||url.hash)throw Error("Invalid P4 probe");
  return url.toString();
}
export function classifyProbe(path,response,body,contentType){
  if(PRIVATE_ENDPOINTS.includes(path)){
    if(response.status!==401&&response.status!==403)return {path,result:"FAIL-PRIVATE-ACCESS",status:response.status};
    if(typeof body==="string"&&/\b(?:set-cookie|access_token|refresh_token|session_secret)\b/i.test(body))
      return {path,result:"FAIL-SENSITIVE-RESPONSE",status:response.status};
    return {path,result:"PASS-PRIVATE-GUARD",status:response.status};
  }
  if(response.status!==200)return {path,result:"FAIL-PUBLIC-HTTP",status:response.status};
  const required=PUBLIC_ASSETS.find(([p])=>p===path)[1];
  if(!contentType.toLowerCase().includes(required))
    return {path,result:"FAIL-CONTENT-TYPE",status:response.status};
  if(path==="/admin" && !body.includes("Administración · Mail Center"))return {path,result:"FAIL-ADMIN-CONTENT",status:response.status};
  if(path==="/api/health"){
    let payload;try{payload=JSON.parse(body)}catch{return {path,result:"FAIL-HEALTH-JSON",status:response.status}};
    if(payload?.status!=="ok")return {path,result:"FAIL-HEALTH-STATUS",status:response.status};
  }
  if(path==="/api/branding"){
    let payload;try{payload=JSON.parse(body)}catch{return {path,result:"FAIL-BRANDING-JSON",status:response.status}};
    if(typeof payload?.product_name!=="string"||payload.product_name.length===0)
      return {path,result:"FAIL-BRANDING-PAYLOAD",status:response.status};
  }
  return {path,result:"PASS-PUBLIC",status:response.status};
}
export function inspectAdminRedirect(response){
  if(response.status!==301&&response.status!==302&&response.status!==303&&response.status!==307&&response.status!==308)
    return null;
  const raw=response.headers.get("location");
  if(!raw)return {result:"FAIL-ADMIN-REDIRECT-MISSING-LOCATION",status:response.status};
  let target;
  try{target=new URL(raw,ORIGIN+"/admin.html");}catch{
    return {result:"FAIL-ADMIN-REDIRECT-INVALID-LOCATION",status:response.status};
  }
  if(target.origin!==ORIGIN||target.username||target.password||target.hash||target.search)
    return {result:"FAIL-ADMIN-REDIRECT-UNTRUSTED",status:response.status,redirect:"external-or-query"};
  if(target.pathname!=="/admin")
    return {result:"FAIL-ADMIN-REDIRECT-UNEXPECTED",status:response.status,redirect:target.pathname};
  return {result:"PENDING-ADMIN-CANONICAL",status:response.status,redirect:"/admin"};
}

export async function runSmoke(fetchFn=fetch){
  const rows=[];
  for(const path of [...PUBLIC_ASSETS.map(([p])=>p),...PRIVATE_ENDPOINTS]){
    try{
      const response=await fetchFn(makeProbe(path),{
        method:"GET",redirect:"manual",cache:"no-store",credentials:"omit",
        headers:{Accept: path.startsWith("/api/")?"application/json":"*/*","Cache-Control":"no-cache"},
        signal:AbortSignal.timeout(12000)
      });
      if(path==="/admin.html"){
        const redirect=inspectAdminRedirect(response);
        if(redirect){
          if(redirect.result==="PENDING-ADMIN-CANONICAL"){
            // A single fixed canonical hop is allowed only when /admin serves the real admin HTML.
            const canonical=await fetchFn(ORIGIN+"/admin",{
              method:"GET",redirect:"manual",cache:"no-store",credentials:"omit",
              headers:{Accept:"text/html","Cache-Control":"no-cache"},signal:AbortSignal.timeout(12000)
            });
            const canonicalBody=(await canonical.text()).slice(0,8192);
            const validated=classifyProbe("/admin",canonical,canonicalBody,canonical.headers.get("content-type")||"");
            rows.push({path,result:validated.result==="PASS-PUBLIC"?
              "PASS-ADMIN-CANONICAL":"FAIL-ADMIN-CANONICAL",
              status:response.status,redirect:"/admin",landingStatus:canonical.status,
              landingResult:validated.result,
              note:"Canonical route verified; authenticated admin API remains separately guarded."});
          }else rows.push({path,...redirect});
          continue;
        }
      }
      const body=await response.text();
      rows.push(classifyProbe(path,response,body.slice(0,8192),response.headers.get("content-type")||""));
    }catch(error){
      rows.push({path,result:"FAIL-NETWORK",reason:error instanceof Error?error.name:"unknown"});
    }
  }
  return {result:rows.every(x=>x.result.startsWith("PASS-"))?"PASS-READ-ONLY":"BLOCKED",rows,
    note:"Read-only anonymous shell and authorization check; not authenticated send/receive, provider, user journey or production release attestation."};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const report=await runSmoke();
  console.log("MSM MAIL P4 PUBLIC SMOKE: "+JSON.stringify(report));
  if(report.result!=="PASS-READ-ONLY")process.exitCode=1;
}
