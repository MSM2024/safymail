import test from "node:test";
import assert from "node:assert/strict";
import {METRICS,assessCloudflareMetrics} from "./p2-cloudflare-metrics.mjs";
const now=new Date("2026-11-05T20:00:00Z");
const make=()=>({schema:"msm-mail-cloudflare-metrics-v1",metrics:METRICS.map(id=>({
 id,availability:"observed",value:10,limit:100,unit:"operations",
 windowStartUtc:"2026-11-05T19:00:00Z",windowEndUtc:"2026-11-05T19:50:00Z",
 observedAtUtc:"2026-11-05T19:55:00Z",operatorVerified:true,
 source:"Cloudflare Dashboard: Workers and Pages metrics"
}))});
test("complete fresh instrumented dashboard values produce metrics-observed only",()=>{
 const out=assessCloudflareMetrics(make(),now);
 assert.equal(out.result,"METRICS-OBSERVED");
 assert.equal(out.checks.length,METRICS.length);
 assert.match(out.note,/snapshot cannot prove queue delivery/i);
});
test("partial unavailable, unknown cap and missing data are not approved",()=>{
 const a=make();a.metrics[0].availability="unavailable";
 assert.equal(assessCloudflareMetrics(a,now).result,"PARTIAL");
 const b=make();b.metrics[0].limit=null;
 assert.deepEqual(assessCloudflareMetrics(b,now).capUnknown,["queue-primary-backlog"]);
 const c=make();c.metrics.pop();
 assert.equal(assessCloudflareMetrics(c,now).result,"PARTIAL");
});
test("fail closed for stale, invented caps, future clocks and duplicates",()=>{
 const stale=make();stale.metrics[0].observedAtUtc="2026-11-05T17:00:00Z";
 assert.equal(assessCloudflareMetrics(stale,now).result,"PARTIAL");
 const uncapped=make();uncapped.metrics[1].limit=0;
 assert.equal(assessCloudflareMetrics(uncapped,now).result,"PARTIAL");
 const future=make();future.metrics[0].observedAtUtc="2026-11-05T20:02:00Z";
 assert.equal(assessCloudflareMetrics(future,now).result,"PARTIAL");
 const dupe=make();dupe.metrics.push(dupe.metrics[0]);
 assert.equal(assessCloudflareMetrics(dupe,now).result,"BLOCKED");
});
test("alerts on high consumption for any quota with confirmed limit",()=>{
 const a=make();a.metrics[5].value=95;
 const out=assessCloudflareMetrics(a,now);
 assert.equal(out.result,"PARTIAL");
 assert.deepEqual(out.concerning,["worker-cpu"]);
 assert.equal(out.checks[5].band,"CRITICAL");
});
