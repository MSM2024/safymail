import { pathToFileURL } from "node:url";
import path from "node:path";
import { validateManifest } from "./p2-release-provenance.mjs";

export const ENDPOINTS = Object.freeze([
  ["custom-domain", "https://mailme.msmmystore.com/msm-release.json"],
  ["direct-worker", "https://msm-mail-preview.msmmystore-74f.workers.dev/msm-release.json"],
]);

export async function inspectEndpoint(label, base, fetchFn = fetch, bust = false) {
  const url = new URL(base);
  const permitted = ENDPOINTS.some(([,value]) => value === url.toString());
  if (!permitted) throw Error("Unrecognized release endpoint");
  if (bust) url.searchParams.set("msm_p2_probe","20261105");
  try {
    const response = await fetchFn(url.toString(), {
      method:"GET",redirect:"manual",cache:"no-store",
      headers:{Accept:"application/json","Cache-Control":"no-cache"},
      signal:AbortSignal.timeout(12000)
    });
    const contentType=(response.headers.get("content-type")||"").toLowerCase();
    const result={
      endpoint: label, probe: bust?"controlled-query":"canonical", status:response.status,
      contentType:contentType || "not-reported",
      cfCacheStatus:response.headers.get("cf-cache-status")||"not-reported",
      age:response.headers.get("age")||"not-reported",
      redirect:response.headers.get("location")?"present":"none",
      classification:"unknown",commit:null
    };
    if(response.status>=300&&response.status<400){result.classification="redirect";return result;}
    if(response.status!==200){result.classification="http-error";return result;}
    if(!contentType.includes("application/json")){result.classification="non-json-or-spa-fallback";return result;}
    let json;
    try{json=await response.json();}catch{result.classification="invalid-json";return result;}
    if(!validateManifest(json)){result.classification="invalid-manifest";return result;}
    result.classification="release-manifest";
    result.commit=json.commit;
    return result;
  } catch (error) {
    return {endpoint:label,probe:bust?"controlled-query":"canonical",classification:"network-error",reason:error instanceof Error?error.name:"unknown"};
  }
}

export function diagnose(results) {
  const custom=results.find(r=>r.endpoint==="custom-domain"&&r.probe==="canonical");
  const direct=results.find(r=>r.endpoint==="direct-worker"&&r.probe==="canonical");
  if(!custom||!direct)return "incomplete";
  if(custom.classification==="release-manifest"&&direct.classification==="release-manifest"){
    return custom.commit===direct.commit?"both-serve-same-manifest":"domain-and-worker-commits-differ";
  }
  if(direct.classification==="release-manifest"&&custom.classification!=="release-manifest")
    return "worker-serves-manifest-custom-domain-does-not";
  if(direct.classification!=="release-manifest"&&custom.classification==="release-manifest")
    return "custom-domain-serves-manifest-worker-does-not";
  return "neither-endpoint-provides-valid-manifest";
}

async function main() {
  const results=[];
  for(const [label,url] of ENDPOINTS){
    results.push(await inspectEndpoint(label,url,fetch,false));
    results.push(await inspectEndpoint(label,url,fetch,true));
  }
  for(const result of results)console.log("P2 RELEASE ROUTE:",JSON.stringify(result));
  const conclusion=diagnose(results);
  console.log("P2 RELEASE ROUTING DIAGNOSIS: "+conclusion);
  if(conclusion!=="both-serve-same-manifest")process.exitCode=1;
  console.log("Read-only: no Worker deployment, DNS changes, database writes or Resend messages.");
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  main().catch(err=>{console.error("P2 RELEASE DIAGNOSTIC FAILED: "+(err instanceof Error?err.message:String(err)));process.exitCode=1;});
}
