import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

export const REQUIRED=Object.freeze([
 ["p4-public","Public routes, branding, assets and unauthenticated guards"],
 ["p4-release","Active Worker version, published release identity and route"],
 ["p4-login","Real authorized login and logout with session invalidation"],
 ["p4-mfa","TOTP MFA challenge and denial without verified MFA"],
 ["p4-isolation","Multi-tenant accounts, mailbox roles and cross-tenant denial"],
 ["p4-inbox","Inbound message, inbox pagination and read-only reader"],
 ["p4-compose","Draft autosave, attachments, reply/forward and idempotent send"],
 ["p4-delivery","Resend outbound accepted, inbound webhook received and visible"],
 ["p4-contacts","Authorized contact create/search/update/delete"],
 ["p4-admin","Admin panel navigation and authorized create/read/update roles"],
 ["p4-mobile","Responsive and keyboard access on mobile and desktop"]
]);
export const ids=REQUIRED.map(([id])=>id);
const safeEvidence=text=>typeof text==="string"&&text.length>=12&&text.length<=350&&
 !/(?:@|Bearer\s+|sk_[a-z0-9]+|whsec_|password|session_token|cookie\s*[:=]|api[_-]?key|authorization|otp\s*[:=]|recovery[_-]?code)/i.test(text);
const safeRef=text=>typeof text==="string"&&/^(?:run:|test:|capture:|ticket:|audit:)[a-z0-9._/-]{8,120}$/i.test(text);
export function assessP4Evidence(doc, now=new Date()){
 if(!doc||doc.schema!=="msm-mail-p4-functional-v1"||!Array.isArray(doc.controls))
  return {result:"BLOCKED",reason:"invalid-schema"};
 if(doc.controls.length>REQUIRED.length)return {result:"BLOCKED",reason:"too-many-controls"};
 const seen=new Set(),checks=[];
 for(const item of doc.controls){
  if(!item||!ids.includes(item.id)||seen.has(item.id))
   return {result:"BLOCKED",reason:"unknown-or-duplicate-id"};
  seen.add(item.id);
  const observed=typeof item.observedAtUtc==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(item.observedAtUtc)?
   Date.parse(item.observedAtUtc):NaN;
  const age=now.getTime()-observed;
  const fresh=Number.isFinite(age)&&age>=0&&age<=48*60*60*1000;
  const credible=item.result==="PASS"&&item.operatorVerified===true&&
   ["instrumented","witnessed"].includes(item.evidenceMode)&&safeRef(item.evidenceRef)&&
   safeEvidence(item.observed)&&fresh;
  checks.push({id:item.id,status:credible?"PASS":item.result==="FAIL"?"FAIL":"PENDING"});
 }
 const missing=ids.filter(id=>!seen.has(id));
 const pending=[...missing,...checks.filter(x=>x.status!=="PASS").map(x=>x.id)];
 return {result:pending.length?"BLOCKED":"GO",pending,checks,
  note:"Evidence ledger validates declared operator/instrumented proof, not independently the authenticity of references or provider deliveries."};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  if(process.argv.length!==3)throw Error("usage: npm run qa:p4:closure -- <private-evidence-ledger.json>");
  const text=readFileSync(resolve(process.argv[2]),"utf8");
  if(text.length>20000)throw Error("ledger over size limit");
  const report=assessP4Evidence(JSON.parse(text));
  console.log("MSM MAIL P4 FUNCTIONAL CLOSURE: "+JSON.stringify(report));
  if(report.result!=="GO")process.exitCode=1;
 }catch(error){
  console.error("MSM MAIL P4 FUNCTIONAL CLOSURE: BLOCKED ("+(error instanceof Error?error.message:String(error)).replace(/(?:Bearer\s+|sk_[a-z0-9]+)/gi,"[REDACTED]")+")");
  process.exitCode=2;
 }
}
