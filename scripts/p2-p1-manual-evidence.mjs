import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

export const P1_IDS = Object.freeze(Array.from({length:7},(_,i)=>"P1-"+String(i+8).padStart(2,"0")));
export function assessManualEvidence(doc) {
 if(!doc || doc.schema!=="msm-mail-p1-manual-v1" || !Array.isArray(doc.checks))
   return {result:"BLOCKED",reason:"invalid-schema"};
 const seen=new Set(), entries=[];
 for(const row of doc.checks) {
   if(!row || !P1_IDS.includes(row.id) || seen.has(row.id))return {result:"BLOCKED",reason:"unexpected-or-duplicate-check"};
   seen.add(row.id);
   const validStatus=["PASS","FAIL","PENDING"].includes(row.result);
   const validMode=["instrumented","operator-reported","pending"].includes(row.evidenceMode);
   const validUtc=typeof row.observedAtUtc==="string"&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(row.observedAtUtc)&&Number.isFinite(Date.parse(row.observedAtUtc));
   const validText=["deviceCategory","roleCategory","expected","observed","evidenceRef"].every(k=>typeof row[k]==="string"&&row[k].length>=4&&row[k].length<=300);
   const safeText=validText && !["deviceCategory","roleCategory","expected","observed","evidenceRef"].some(k=>/(?:whsec_|sk_[a-z0-9]+|Bearer\s+|@|session_token|password\s*[:=])/i.test(row[k]));
   const accepted=validStatus&&validMode&&row.result==="PASS"&&row.evidenceMode==="instrumented"&&validUtc&&safeText;
   entries.push({id:row.id,status:accepted?"PASS":row.result==="FAIL"?"FAIL":"PENDING",evidenceMode:row.evidenceMode??"unknown"});
 }
 const missing=P1_IDS.filter(id=>!seen.has(id));
 const pending=[...missing,...entries.filter(e=>e.status!=="PASS").map(e=>e.id)];
 return {result:pending.length?"BLOCKED":"PASS",pending,checks:entries};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  if(process.argv.length!==3)throw Error("usage: node scripts/p2-p1-manual-evidence.mjs <local-private-ledger-json>");
  const raw=readFileSync(path.resolve(process.argv[2]),"utf8");
  if(raw.length>30000)throw Error("ledger exceeds 30 KB");
  const report=assessManualEvidence(JSON.parse(raw));
  console.log("P2 P1 MANUAL EVIDENCE: "+JSON.stringify(report));
  if(report.result!=="PASS")process.exitCode=1;
 }catch(e){console.error("P2 P1 MANUAL EVIDENCE BLOCKED: "+(e instanceof Error?e.message:String(e)));process.exitCode=2;}
}
