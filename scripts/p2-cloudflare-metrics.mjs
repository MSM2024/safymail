import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import path from "node:path";

export const METRICS=Object.freeze([
 "queue-primary-backlog","queue-primary-retries","queue-primary-consumer-errors",
 "queue-dlq-backlog","worker-requests","worker-cpu","d1-reads","d1-writes",
 "d1-storage","kv-operations","kv-storage","queue-operations"
]);
export const QUEUE_METRICS=METRICS.slice(0,4);
export const BUDGET_METRICS=METRICS.slice(4);
const UTC=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const VALID_UNITS=new Set(["messages","operations","requests","reads","writes","bytes","milliseconds"]);
const isUtc=t=>typeof t==="string"&&UTC.test(t)&&Number.isFinite(Date.parse(t));
const isCount=n=>typeof n==="number"&&Number.isFinite(n)&&n>=0;
export function assessCloudflareMetrics(input,now=new Date()){
 if(!input||input.schema!=="msm-mail-cloudflare-metrics-v1"||!Array.isArray(input.metrics))
  return {result:"BLOCKED",reason:"invalid-schema"};
 const seen=new Set(),checks=[];
 for(const row of input.metrics){
   if(!row||!METRICS.includes(row.id)||seen.has(row.id))return {result:"BLOCKED",reason:"unknown-or-duplicate-metric"};
   seen.add(row.id);
   let status="UNKNOWN",reason="unverified-or-incomplete";
   if(row.availability==="unavailable"){reason="not-exposed-by-provider";}
   else if(row.availability==="observed"){
     const source=typeof row.source==="string"&&/^Cloudflare Dashboard: [A-Za-z0-9 /()._-]{8,180}$/.test(row.source);
     const dates=isUtc(row.observedAtUtc)&&isUtc(row.windowStartUtc)&&isUtc(row.windowEndUtc);
     const span=dates&&Date.parse(row.windowEndUtc)>Date.parse(row.windowStartUtc)&&
       Date.parse(row.windowEndUtc)<=Date.parse(row.observedAtUtc)+60000;
     const age=dates?now.getTime()-Date.parse(row.observedAtUtc):NaN;
     const fresh=age>=0&&age<=3600000;
     const values=isCount(row.value)&&VALID_UNITS.has(row.unit)&&
       (row.limit===null||(isCount(row.limit)&&row.limit>0));
     if(source&&dates&&span&&fresh&&values&&row.operatorVerified===true){
       status="OBSERVED";reason="checked";
     }else reason="invalid-observation";
   }
   const utilization=status==="OBSERVED"&&typeof row.limit==="number"?row.value/row.limit:null;
   const band=utilization===null?"UNKNOWN":utilization>=1?"EXHAUSTED":utilization>=.95?"CRITICAL":utilization>=.8?"WARNING":utilization>=.5?"WATCH":"BELOW-WATCH";
   checks.push({id:row.id,status,band,reason});
 }
 const missing=METRICS.filter(id=>!seen.has(id));
 const incomplete=[...missing,...checks.filter(c=>c.status!=="OBSERVED").map(c=>c.id)];
 const capUnknown=checks.filter(c=>c.status==="OBSERVED"&&c.band==="UNKNOWN").map(c=>c.id);
 const concerning=checks.filter(c=>["EXHAUSTED","CRITICAL","WARNING"].includes(c.band)).map(c=>c.id);
 // Even when dashboard metrics appear healthy, Queue success is a separate
 // provider/consumer validation, not inferred from a zero backlog snapshot.
 const result=incomplete.length||capUnknown.length||concerning.length?"PARTIAL":"METRICS-OBSERVED";
 return {result,missing,incomplete,capUnknown,concerning,checks,
  note:"A snapshot cannot prove queue delivery or zero historical retries. Confirm consumer history and DLQ separately; no plan cap is inferred."};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
   if(process.argv.length!==3)throw Error("usage: node scripts/p2-cloudflare-metrics.mjs <private-local-json>");
   const raw=readFileSync(path.resolve(process.argv[2]),"utf8");
   if(raw.length>20000)throw Error("metrics evidence too large");
   const report=assessCloudflareMetrics(JSON.parse(raw));
   console.log("P2 CLOUDFLARE METRICS: "+JSON.stringify(report));
   if(report.result!=="METRICS-OBSERVED")process.exitCode=1;
 }catch(e){console.error("P2 CLOUDFLARE METRICS BLOCKED: "+(e instanceof Error?e.message:String(e)));process.exitCode=2;}
}
