import {readFileSync,existsSync} from "node:fs";
import {execFileSync} from "node:child_process";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
export const WORKER="msm-mail-preview";
export function assessDeployPreflight(input){
  if(!input||typeof input!=="object")return {result:"BLOCKED",reason:"missing-input"};
  if(input.branch!=="main")return {result:"BLOCKED",reason:"not-main-branch"};
  if(!/^[0-9a-f]{40}$/.test(input.head)||input.head!==input.originMain)
    return {result:"BLOCKED",reason:"not-synchronized-with-origin-main"};
  if(typeof input.gitStatus!=="string"||input.gitStatus.trim())
    return {result:"BLOCKED",reason:"tracked-worktree-dirty"};
  if(typeof input.config!=="string")return {result:"BLOCKED",reason:"wrangler-config-missing"};
  const named=input.config.match(/^name\s*=\s*"([^"]+)"\s*(?:#.*)?$/m)?.[1];
  if(named!==WORKER)return {result:"BLOCKED",reason:"wrong-worker-target"};
  if(!/^(?:main\s*=|\[assets\])/m.test(input.config))
    return {result:"BLOCKED",reason:"worker-source-or-assets-missing"};
  return {result:"READY-FOR-LOCAL-DRY-RUN",head:input.head,worker:WORKER,
    note:"No Cloudflare credential, remote bindings, production E2E, or active deployment has been checked."};
}
function git(args){
 return execFileSync("git",args,{cwd:ROOT,encoding:"utf8",timeout:15000,
  maxBuffer:1024*1024,stdio:["ignore","pipe","pipe"]}).trim();
}
export function localPreflight(){
 const configPath=path.join(ROOT,"wrangler.toml");
 if(!existsSync(configPath))return {result:"BLOCKED",reason:"wrangler-config-missing"};
 return assessDeployPreflight({
   branch:git(["branch","--show-current"]),
   head:git(["rev-parse","HEAD"]),
   originMain:git(["rev-parse","origin/main"]),
   gitStatus:git(["status","--porcelain","--untracked-files=no"]),
   config:readFileSync(configPath,"utf8")
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  if(process.argv.length!==2)throw Error("No arguments accepted; this check never deploys");
  const report=localPreflight();
  console.log("MSM MAIL P3 DEPLOY PREFLIGHT: "+JSON.stringify(report));
  if(report.result!=="READY-FOR-LOCAL-DRY-RUN")process.exitCode=1;
 }catch(error){
  console.error("MSM MAIL P3 DEPLOY PREFLIGHT: BLOCKED ("+
    (error instanceof Error?error.message:String(error)).replace(/(?:Bearer\s+|sk_[a-z0-9]+)/gi,"[REDACTED]")+")");
  process.exitCode=2;
 }
}
