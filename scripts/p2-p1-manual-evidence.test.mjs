import test from "node:test";
import assert from "node:assert/strict";
import {assessManualEvidence,P1_IDS} from "./p2-p1-manual-evidence.mjs";

const make=()=>({schema:"msm-mail-p1-manual-v1",checks:P1_IDS.map(id=>({
 id,result:"PASS",evidenceMode:"instrumented",observedAtUtc:"2026-11-05T19:20:00Z",
 deviceCategory:"desktop browser",roleCategory:"test operator",
 expected:"Action completed as designed",observed:"Action completed as designed",
 evidenceRef:"Private redacted test log record"
}))});
test("all P1-08..14 instrumented entries produce PASS",()=>{
 const result=assessManualEvidence(make());
 assert.equal(result.result,"PASS");
 assert.deepEqual(result.pending,[]);
});
test("reported-only, absent or failed entries do not count as instrumented",()=>{
 const reported=make();reported.checks[0].evidenceMode="operator-reported";
 assert.equal(assessManualEvidence(reported).result,"BLOCKED");
 const absent=make();absent.checks.pop();
 assert.equal(assessManualEvidence(absent).result,"BLOCKED");
 const failed=make();failed.checks[0].result="FAIL";
 assert.equal(assessManualEvidence(failed).checks[0].status,"FAIL");
});
test("refuse duplicate, identifiers or invalid timestamps",()=>{
 const duplicate=make();duplicate.checks.push(duplicate.checks[0]);
 assert.equal(assessManualEvidence(duplicate).result,"BLOCKED");
 const sensitive=make();sensitive.checks[0].evidenceRef="personal@example.com";
 assert.equal(assessManualEvidence(sensitive).result,"BLOCKED");
 const invalid=make();invalid.checks[0].observedAtUtc="not-a-time";
 assert.equal(assessManualEvidence(invalid).result,"BLOCKED");
});
