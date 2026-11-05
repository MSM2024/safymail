import {spawnSync} from "node:child_process";
import {fileURLToPath,pathToFileURL} from "node:url";
import path from "node:path";
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
export const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

export function assessReadOnlyPreflight({gitStatus,releaseExit,activeExit,activeOutput,expectedVersion}){
 if(!UUID.test(expectedVersion))return {result:"BLOCKED",reason:"invalid-expected-version"};
 if(typeof gitStatus!=="string" || gitStatus.trim())return {result:"BLOCKED",reason:"tracked-worktree-not-clean"};
 if(releaseExit!==0)return {result:"BLOCKED",reason:"published-release-manifest-not-verified"};
 if(activeExit!==0 || typeof activeOutput!=="string" || !activeOutput.includes('"result":"expected-version-at-100-percent"') ||
 !activeOutput.includes('"expectedVersion":"'+expectedVersion+'"'))return {result:"BLOCKED",reason:"active-worker-version-not-confirmed"};
 return {result:"PASS-METADATA-ONLY",workerVersion:expectedVersion,
  note:"Read-only metadata checks passed; not a bundle digest, rollback rehearsal or E2E production certificate."};
}
export function performReadOnlyPreflight(expectedVersion,run=spawnSync){
 if(!UUID.test(expectedVersion))return {result:"BLOCKED",reason:"invalid-expected-version"};
 const opts={cwd:ROOT,encoding:"utf8",timeout:45000,maxBuffer:2*1024*1024,shell:false,windowsHide:true};
 const git=run("git",["status","--porcelain","--untracked-files=no"],opts);
 if(git.error||git.status!==0)return {result:"BLOCKED",reason:"git-status-unavailable"};
 if(git.stdout.trim())return {result:"BLOCKED",reason:"tracked-worktree-not-clean"};
 const release=run(process.execPath,["scripts/p2-release-provenance.mjs","verify"],opts);
 const active=run(process.execPath,["scripts/p2-worker-active-version-audit.mjs",expectedVersion],opts);
 return assessReadOnlyPreflight({gitStatus:git.stdout,releaseExit:release.status,activeExit:active.status,
  activeOutput:active.stdout,expectedVersion});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const version=process.argv[2]||"";
 const result=performReadOnlyPreflight(version);
 console.log("P2 RELEASE READ-ONLY PREFLIGHT: "+JSON.stringify(result));
 if(result.result!=="PASS-METADATA-ONLY")process.exitCode=1;
}
