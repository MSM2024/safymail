import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {makeProbe, classifyProbe, runSmoke, PUBLIC_ASSETS, PRIVATE_ENDPOINTS} from "./p4-public-smoke.mjs";

const source=readFileSync(new URL("../src/index.ts",import.meta.url),"utf8");
test("branding is public through both session and tenant middleware",()=>{
 const guard='path === "/api/health" || path === "/api/branding" || path === "/api/webhooks/resend" || path.startsWith("/api/auth/")';
 assert.equal(source.split(guard).length-1,2);
 assert.ok(source.includes('app.get("/api/branding"'));
 assert.ok(source.includes('company_access_hosts'));
});
test("P4 probes are allowlisted, read only and fixed to the official domain",async()=>{
 assert.ok(PUBLIC_ASSETS.some(([p])=>p==="/api/branding"));
 for(const path of PRIVATE_ENDPOINTS)assert.equal(makeProbe(path),"https://mailme.msmmystore.com"+path);
 assert.throws(()=>makeProbe("//hostile.example/x"),/approved/);
 assert.throws(()=>makeProbe("/api/messages/send"),/approved/);
 const requests=[];
 const r=await runSmoke(async (url,opts)=>{
  requests.push({url,opts});
  const path=new URL(url).pathname;
  if(PRIVATE_ENDPOINTS.includes(path))return new Response(JSON.stringify({error:"unauthorized"}),{status:401,headers:{"Content-Type":"application/json"}});
  const type=path==="/"||path==="/admin.html"?"text/html":path.endsWith(".css")?"text/css":path.endsWith(".js")?"text/javascript":"application/json";
  const body=path==="/api/health"?JSON.stringify({status:"ok"}):path==="/api/branding"?JSON.stringify({product_name:"Mail Center",company_name:null}):"shell";
  return new Response(body,{status:200,headers:{"Content-Type":type}});
 });
 assert.equal(r.result,"PASS-READ-ONLY");
 assert.equal(requests.length,PUBLIC_ASSETS.length+PRIVATE_ENDPOINTS.length);
 for(const {opts} of requests){
   assert.equal(opts.method,"GET");
   assert.equal(opts.redirect,"manual");
   assert.equal(opts.credentials,"omit");
   assert.equal(opts.headers.Authorization,undefined);
 }
});
test("fails closed for leaked private data, broken public branding and redirects",()=>{
 const r=(status)=>({status});
 assert.equal(classifyProbe("/api/me",r(200),"{}", "application/json").result,"FAIL-PRIVATE-ACCESS");
 assert.equal(classifyProbe("/api/me",r(401),'{"access_token":"secret"}',"application/json").result,"FAIL-SENSITIVE-RESPONSE");
 assert.equal(classifyProbe("/api/branding",r(401),"{}", "application/json").result,"FAIL-PUBLIC-HTTP");
 assert.equal(classifyProbe("/api/branding",r(200),"{}", "application/json").result,"FAIL-BRANDING-PAYLOAD");
 assert.equal(classifyProbe("/",r(302),"", "text/html").result,"FAIL-PUBLIC-HTTP");
 assert.equal(classifyProbe("/api/health",r(200),'{"status":"degraded"}',"application/json").result,"FAIL-HEALTH-STATUS");
});
