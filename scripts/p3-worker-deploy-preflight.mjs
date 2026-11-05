import {readFileSync,existsSync} from "node:fs";
import {execFileSync} from "node:child_process";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
export const WORKER="msm-mail-preview";
export const APPROVED_REPO="https://github.com/MSM2024/safymail.git";
export function isApprovedRemote(url){
 return typeof url==="string" && /^(?:https:\/\/github\.com\/MSM2024\/safymail(?:\.git)?|git@github\.com:MSM2024\/safymail\.git)$/.test(url.trim());
}
export function assessDeployPreflight(input){
  if(!input||typeof input!=="object")return {result:"BLOCKED",reason:"missing-input"};
  if(!isApprovedRemote(input.remoteUrl))return {result:"BLOCKED",reason:"unexpected-release-remote"};
  if(input.branch!=="main")return {result:"BLOCKED",reason:"not-main-branch"};
  if(!/^[0-9a-f]{40}$/.test(input.head)||input.head!==input.releaseMain)
    return {result:"BLOCKED",reason:"not-synchronized-with-approved-release-main"};
  if(typeof input.gitStatus!=="string"||input.gitStatus.trim())
    return {result:"BLOCKED",reason:"tracked-worktree-dirty"};
  if(typeof input.config!=="string")return {result:"BLOCKED",reason:"wrangler-config-missing"};
  const config=input.config.replace(/^\uFEFF/,"");
  const named=config.match(/^[ \t]*name[ \t]*=[ \t]*"([^"\r\n]+)"[ \t]*(?:#[^\r\n]*)?\r?$/m)?.[1];
  if(named!==WORKER)return {result:"BLOCKED",reason:"wrong-worker-target"};
  if(!/^[ \t]*(?:main[ \t]*=|\[assets\][ \t]*\r?$)/m.test(config))
    return {result:"BLOCKED",reason:"worker-source-or-assets-missing"};
  return {result:"READY-FOR-LOCAL-DRY-RUN",head:input.head,worker:WORKER,
    note:"No Cloudflare credential, remote bindings, production E2E, or active deployment has been checked."};
}
function git(args){
 return execFileSync("git",args,{cwd:ROOT,encoding:"utf8",timeout:15000,
  maxBuffer:1024*1024,stdio:["ignore","pipe","pipe"]}).trim();
}
export function localPreflight(){
 const remote=process.env.MSM_RELEASE_REMOTE||"msm";
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/.test(remote))return {result:"BLOCKED",reason:"invalid-release-remote-name"};
 let remoteUrl;
 try{remoteUrl=git(["remote","get-url",remote]);}catch{return {result:"BLOCKED",reason:"release-remote-unconfigured"};}
 if(!isApprovedRemote(remoteUrl))return {result:"BLOCKED",reason:"unexpected-release-remote"};
 const configPath=path.join(ROOT,"wrangler.toml");
 if(!existsSync(configPath))return {result:"BLOCKED",reason:"wrangler-config-missing"};
 return assessDeployPreflight({
   branch:git(["branch","--show-current"]),
   head:git(["rev-parse","HEAD"]),
   releaseMain:git(["rev-parse","refs/remotes/"+remote+"/main"]),
   remoteUrl,
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
