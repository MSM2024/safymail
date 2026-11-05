import test from "node:test";
import assert from "node:assert/strict";
import {assessReadOnlyPreflight,performReadOnlyPreflight} from "./p2-release-readonly-preflight.mjs";
const v="94a7ed90-9478-4cc6-b339-97d6ca23d2b4";
const green={gitStatus:"",releaseExit:0,activeExit:0,activeOutput:'P2 WORKER ACTIVE VERSION: {"expectedVersion":"'+v+'","result":"expected-version-at-100-percent"}',expectedVersion:v};
test("release preflight only attests published metadata and active Worker",()=>{
 const result=assessReadOnlyPreflight(green);
 assert.equal(result.result,"PASS-METADATA-ONLY");
 assert.match(result.note,/not a bundle digest/);
});
test("preflight fails closed on wrong version, dirty tree and missing remote attestations",()=>{
 assert.equal(assessReadOnlyPreflight({...green,expectedVersion:"invalid"}).result,"BLOCKED");
 assert.equal(assessReadOnlyPreflight({...green,gitStatus:" M src/index.ts"}).result,"BLOCKED");
 assert.equal(assessReadOnlyPreflight({...green,releaseExit:1}).result,"BLOCKED");
 assert.equal(assessReadOnlyPreflight({...green,activeExit:1}).result,"BLOCKED");
 assert.equal(assessReadOnlyPreflight({...green,activeOutput:green.activeOutput.replace(v,"a423e816-61f9-455e-9ac0-208c297d2ebb")}).result,"BLOCKED");
});
test("preflight uses only git status and Node read-only audit scripts",()=>{
 const calls=[];
 const result=performReadOnlyPreflight(v,(cmd,args,opts)=>{
  calls.push({cmd,args,opts});
  return {status:0,stdout:calls.length===1?"":calls.length===2?"verified":green.activeOutput};
 });
 assert.equal(result.result,"PASS-METADATA-ONLY");
 assert.equal(calls.length,3);
 assert.deepEqual(calls[0].args,["status","--porcelain","--untracked-files=no"]);
 assert.deepEqual(calls[1].args,["scripts/p2-release-provenance.mjs","verify"]);
 assert.deepEqual(calls[2].args,["scripts/p2-worker-active-version-audit.mjs",v]);
 assert.ok(calls.every(c=>c.opts.shell===false));
});
