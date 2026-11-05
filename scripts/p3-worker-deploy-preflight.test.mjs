import test from "node:test";
import assert from "node:assert/strict";
import {assessDeployPreflight,WORKER} from "./p3-worker-deploy-preflight.mjs";
const sha="a".repeat(40);
const good=()=>({branch:"main",head:sha,originMain:sha,gitStatus:"",
 config:'name = "msm-mail-preview"\nmain = "src/index.ts"\n[assets]\ndirectory = "./public"\n'});
test("valid main snapshot and target only allows local dry run",()=>{
 const r=assessDeployPreflight(good());
 assert.equal(r.result,"READY-FOR-LOCAL-DRY-RUN");
 assert.equal(r.worker,WORKER);
 assert.match(r.note,/No Cloudflare credential/);
});
test("wrong worker and missing config are blocked",()=>{
 assert.equal(assessDeployPreflight({...good(),config:'name = "msm-mail-control-plane"\nmain = "src/index.ts"'}).result,"BLOCKED");
 assert.equal(assessDeployPreflight({...good(),config:""}).result,"BLOCKED");
 assert.equal(assessDeployPreflight({...good(),config:'name = "msm-mail-preview"'}).result,"BLOCKED");
});
test("detached branch, stale main or modified tracked files cannot pass",()=>{
 assert.equal(assessDeployPreflight({...good(),branch:"feature/ui"}).result,"BLOCKED");
 assert.equal(assessDeployPreflight({...good(),originMain:"b".repeat(40)}).result,"BLOCKED");
 assert.equal(assessDeployPreflight({...good(),gitStatus:" M public/index.html"}).result,"BLOCKED");
});
