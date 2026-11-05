import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import path from "node:path";

export const REQUIRED=["p2-01-bundle","p2-02-provider","p2-04-queues","p2-05-cloudflare","p2-06-manual","p2-07-rollback"];
export function assessP2Evidence(document,now=new Date()){
  if(!document || document.schema!=="msm-mail-p2-evidence-v1" || !Array.isArray(document.controls))
    return {result:"BLOCKED",reason:"invalid-schema"};
  const seen=new Set();
  const results=[];
  for(const item of document.controls){
    if(!item || typeof item.id!=="string" || seen.has(item.id) || !REQUIRED.includes(item.id))
      return {result:"BLOCKED",reason:"unknown-or-duplicate-id"};
    seen.add(item.id);
    const evidence=typeof item.evidence==="string" && item.evidence.length>=12 && item.evidence.length<=500 && !/(?:whsec_|sk_[a-z0-9]+|Bearer\s+|CONTROL_PLANE_VAULT_KEY\s*=)/i.test(item.evidence);
    const stamped=typeof item.observedAtUtc==="string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(item.observedAtUtc) && !Number.isNaN(Date.parse(item.observedAtUtc));
    const age=stamped?now.getTime()-Date.parse(item.observedAtUtc):NaN;
    const fresh=Number.isFinite(age)&&age>=0&&age<=24*3600*1000;
    const passed=item.result==="PASS"&&evidence&&fresh&&item.operatorVerified===true;
    results.push({id:item.id,status:passed?"PASS":"PENDING"});
  }
  const missing=REQUIRED.filter(id=>!seen.has(id));
  const pending=[...missing,...results.filter(r=>r.status!=="PASS").map(r=>r.id)];
  return {result:pending.length?"BLOCKED":"GO",pending,controls:results};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
   if(process.argv.length!==3)throw Error("usage: node scripts/p2-closure-gate.mjs <local-evidence-json>");
   const raw=readFileSync(path.resolve(process.argv[2]),"utf8");
   if(raw.length>15000)throw Error("evidence file exceeds size limit");
   const report=assessP2Evidence(JSON.parse(raw));
   console.log("P2 CLOSURE GATE: "+JSON.stringify(report));
   if(report.result!=="GO")process.exitCode=1;
 }catch(error){console.error("P2 CLOSURE GATE: BLOCKED ("+(error instanceof Error?error.message:String(error))+")");process.exitCode=2;}
}
