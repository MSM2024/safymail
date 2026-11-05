import test from "node:test";
import assert from "node:assert/strict";
import { ENDPOINTS,inspectEndpoint,diagnose } from "./p2-release-routing-diagnostic.mjs";
import { makeManifest } from "./p2-release-provenance.mjs";
const m=makeManifest("a".repeat(40),"code","html","2026-11-05T17:35:00Z");
const json=()=>new Response(JSON.stringify(m),{headers:{"Content-Type":"application/json"}});
const html=()=>new Response("<html>login</html>",{headers:{"Content-Type":"text/html"}});
test("two fixed trusted URLs and controlled probe query",async()=>{
 let seen;
 const r=await inspectEndpoint("custom-domain",ENDPOINTS[0][1],async (url,opts)=>{seen={url,opts};return json();},true);
 assert.equal(r.classification,"release-manifest");assert.equal(r.commit,m.commit);
 assert.equal(new URL(seen.url).search,"?msm_p2_probe=20261105");
 assert.equal(seen.opts.redirect,"manual");
 assert.equal(seen.opts.headers.Authorization,undefined);
});
test("detects SPA fallback and distinguishes direct Worker from custom domain",async()=>{
 const direct=await inspectEndpoint("direct-worker",ENDPOINTS[1][1],async()=>json());
 const custom=await inspectEndpoint("custom-domain",ENDPOINTS[0][1],async()=>html());
 assert.equal(custom.classification,"non-json-or-spa-fallback");
 assert.equal(diagnose([custom,direct]),"worker-serves-manifest-custom-domain-does-not");
});
test("fails closed on non-allowlisted hosts, redirects and malformed json",async()=>{
 await assert.rejects(inspectEndpoint("bad","https://evil.test/msm-release.json",async()=>json()),/Unrecognized/);
 assert.equal((await inspectEndpoint("direct-worker",ENDPOINTS[1][1],async()=>new Response(null,{status:307,headers:{Location:"https://evil.test/"}}))).classification,"redirect");
 assert.equal((await inspectEndpoint("direct-worker",ENDPOINTS[1][1],async()=>new Response("{",{headers:{"Content-Type":"application/json"}}))).classification,"invalid-json");
});
test("network failure gives explicit diagnosis and does not impersonate manifest",async()=>{
 const result=await inspectEndpoint("direct-worker",ENDPOINTS[1][1],async()=>{throw new Error("offline");});
 assert.equal(result.classification,"network-error");
 assert.equal(result.reason,"Error");
});
