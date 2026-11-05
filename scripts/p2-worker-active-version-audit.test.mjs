import test from "node:test";
import assert from "node:assert/strict";
import { extractAccountId, classifyDeployments, classifyWranglerOutput, readWranglerDeployment, readCloudflareDeployment } from "./p2-worker-active-version-audit.mjs";

const expected="94a7ed90-9478-4cc6-b339-97d6ca23d2b4";
const other="a423e816-61f9-455e-9ac0-208c297d2ebb";
test("restricts account and worker binding to expected script",()=>{
  assert.equal(extractAccountId('name = "msm-mail-preview"\naccount_id = "'+"a".repeat(32)+'"\n'),"a".repeat(32));
  assert.throws(()=>extractAccountId('name = "unknown"\naccount_id = "'+"a".repeat(32)+'"\n'),/Unexpected Worker/);
});
test("latest Cloudflare deployment must serve exactly expected version at 100%",()=>{
  const d=[{created_on:"2026-11-05T16:01:12Z",versions:[{version_id:other,percentage:100}]},
    {created_on:"2026-11-05T17:37:15Z",versions:[{version_id:expected,percentage:100}]}];
  assert.equal(classifyDeployments(d,expected).result,"expected-version-at-100-percent");
  assert.equal(classifyDeployments(d,other).result,"deployment-version-mismatch");
  assert.equal(classifyDeployments([{created_on:d[1].created_on,versions:[{version_id:expected,percentage:75},{version_id:other,percentage:25}]}],expected).result,"deployment-version-mismatch");
  assert.equal(classifyDeployments([],expected).result,"no-deployments");
});
test("read-only API uses GET fixed worker and no secret disclosure",async()=>{
 let observed;
 const data=await readCloudflareDeployment("a".repeat(32),"private-token-not-for-output",async(url,opts)=>{
   observed={url,method:opts.method,redirect:opts.redirect,auth:opts.headers.Authorization};
   return new Response(JSON.stringify({success:true,result:[]}),{headers:{"content-type":"application/json"}});
 });
 assert.deepEqual(data,[]);
 assert.match(observed.url,/\/workers\/scripts\/msm-mail-preview\/deployments\?per_page=100$/);
 assert.equal(observed.method,"GET");
 assert.equal(observed.redirect,"error");
 assert.equal(observed.auth,"Bearer private-token-not-for-output");
});
test("fails closed on invalid API response or status",async()=>{
 await assert.rejects(readCloudflareDeployment("a".repeat(32),"private-token-not-for-output",async()=>new Response("no",{status:403})),/HTTP 403/);
 await assert.rejects(readCloudflareDeployment("a".repeat(32),"private-token-not-for-output",async()=>new Response(JSON.stringify({success:false,result:[]}))),/invalid deployment response/);
});

test("Wrangler 4 text parser selects latest deployment with 100 percent traffic", () => {
  const sample=[
    "Created:     2026-11-05T16:01:12.122Z",
    "Version(s):  (100%) a423e816-61f9-455e-9ac0-208c297d2ebb",
    "Created:     2026-11-05T17:37:15.766Z",
    "Version(s):  (100%) 94a7ed90-9478-4cc6-b339-97d6ca23d2b4"
  ].join("\n");
  assert.equal(classifyWranglerOutput(sample,expected).result,"expected-version-at-100-percent");
  assert.equal(classifyWranglerOutput(sample,other).result,"deployment-version-mismatch");
  const split=sample.replace("(100%) 94a7", "(75%) 94a7");
  assert.equal(classifyWranglerOutput(split,expected).result,"deployment-version-mismatch");
  assert.equal(classifyWranglerOutput("Not a deployment",expected).result,"unreadable-deployments");
});
test("Wrangler fallback only reads deployment listing with safe fixed arguments",()=>{
  let seen;
  const out=readWranglerDeployment(expected,(cmd,args,options)=>{
    seen={cmd,args,options};
    return {status:0,stdout:"Created: 2026-11-05T17:37:15.766Z\nVersion(s): (100%) "+expected};
  });
  assert.equal(out.result,"expected-version-at-100-percent");
  assert.deepEqual(seen.args,["--no-install","wrangler","deployments","list","--config","wrangler.toml"]);
  assert.equal(seen.options.windowsHide,true);
  assert.throws(()=>readWranglerDeployment(expected,()=>({status:1,stdout:""})),/unavailable/);
});
