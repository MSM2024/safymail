import test from "node:test";
import assert from "node:assert/strict";
import {assessP4Evidence,REQUIRED,ids} from "./p4-functional-closure.mjs";
const now=new Date("2026-11-06T00:00:00Z");
const good=()=>({schema:"msm-mail-p4-functional-v1",controls:REQUIRED.map(([id])=>({
 id,result:"PASS",observedAtUtc:"2026-11-05T23:00:00Z",evidenceMode:"instrumented",
 operatorVerified:true,evidenceRef:"run:p4check-123456",observed:"Verified expected response and correct authorized behavior."
}))});
test("P4 closeout requires complete credible recent evidence",()=>{
 const report=assessP4Evidence(good(),now);
 assert.equal(report.result,"GO");
 assert.equal(report.checks.length,11);
 assert.deepEqual(report.pending,[]);
});
test("public smoke alone cannot close authenticated P4",()=>{
 const d=good();d.controls=d.controls.filter(x=>x.id==="p4-public");
 const report=assessP4Evidence(d,now);
 assert.equal(report.result,"BLOCKED");
 assert.ok(report.pending.includes("p4-delivery"));
 assert.ok(report.pending.includes("p4-mfa"));
});
test("never accept duplicate checks, stale proof, empty references, or secrets",()=>{
 const duplicate=good();duplicate.controls.push({...duplicate.controls[0]});
 assert.equal(assessP4Evidence(duplicate,now).result,"BLOCKED");
 const stale=good();stale.controls[0].observedAtUtc="2026-10-25T00:00:00Z";
 assert.ok(assessP4Evidence(stale,now).pending.includes(ids[0]));
 const secret=good();secret.controls[0].observed="Bearer secret token was used for the test";
 assert.ok(assessP4Evidence(secret,now).pending.includes(ids[0]));
 const ref=good();ref.controls[0].evidenceRef="https://example.com/private?q=token";
 assert.ok(assessP4Evidence(ref,now).pending.includes(ids[0]));
});
test("operator reports are not automatically instrumented evidence",()=>{
 const report=good();
 report.controls[0].evidenceMode="operator-reported";
 report.controls[1].operatorVerified=false;
 assert.equal(assessP4Evidence(report,now).result,"BLOCKED");
 assert.ok(report.controls.length===11);
});
test("invalid schema, future proof and unknown identifiers fail closed",()=>{
 assert.equal(assessP4Evidence({},now).result,"BLOCKED");
 const future=good();future.controls[0].observedAtUtc="2026-11-07T00:00:00Z";
 assert.ok(assessP4Evidence(future,now).pending.includes("p4-public"));
 const extra=good();extra.controls[0].id="p4-unknown";
 assert.equal(assessP4Evidence(extra,now).reason,"unknown-or-duplicate-id");
});
