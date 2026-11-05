import test from "node:test";
import assert from "node:assert/strict";
import {assessP2Evidence,REQUIRED} from "./p2-closure-gate.mjs";
const now=new Date("2026-11-05T20:00:00Z");
const stamp="2026-11-05T19:45:00Z";
const good=()=>({schema:"msm-mail-p2-evidence-v1",controls:REQUIRED.map(id=>({id,result:"PASS",evidence:"private provider dashboard observed without secrets",observedAtUtc:stamp,operatorVerified:true}))});
test("all six external gates require recent authorized operator evidence",()=>{
 const report=assessP2Evidence(good(),now);
 assert.equal(report.result,"GO");
 assert.equal(report.pending.length,0);
});
test("missing or stale evidence cannot claim full closure",()=>{
 const missing=good();missing.controls.pop();
 assert.equal(assessP2Evidence(missing,now).result,"BLOCKED");
 const stale=good();stale.controls[0].observedAtUtc="2026-11-04T18:00:00Z";
 assert.equal(assessP2Evidence(stale,now).result,"BLOCKED");
 const unchecked=good();unchecked.controls[0].operatorVerified=false;
 assert.equal(assessP2Evidence(unchecked,now).result,"BLOCKED");
 const partial=good();partial.controls[0].result="PENDING";
 assert.equal(assessP2Evidence(partial,now).result,"BLOCKED");
});
test("duplicate controls, unsafe credential text or future timestamps block closure",()=>{
 const duplicate=good();duplicate.controls.push(duplicate.controls[0]);
 assert.equal(assessP2Evidence(duplicate,now).result,"BLOCKED");
 const secret=good();secret.controls[0].evidence="Bearer should-never-be-in-an-evidence-report";
 assert.equal(assessP2Evidence(secret,now).result,"BLOCKED");
 const future=good();future.controls[1].observedAtUtc="2026-11-05T20:05:00Z";
 assert.equal(assessP2Evidence(future,now).result,"BLOCKED");
});
