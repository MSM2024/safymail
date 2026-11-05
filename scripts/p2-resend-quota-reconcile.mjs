import { pathToFileURL } from "node:url";
import path from "node:path";

export const LIMITS=Object.freeze({daily:100,monthly:3000});
export function counter(value, name) {
  if(!Number.isSafeInteger(value)||value<0)throw Error(name+" must be a nonnegative integer");
  return value;
}
export function evaluateQuota({localDaily,localMonthly,providerDaily=null,providerMonthly=null,providerObservedAt=null,now=new Date()}) {
  const ld=counter(localDaily,"localDaily"),lm=counter(localMonthly,"localMonthly");
  if((providerDaily===null)!==(providerMonthly===null))throw Error("Both provider counters must be supplied together");
  const known=providerDaily!==null;
  let pd=null,pm=null,observedAt=null;
  if(known){
    pd=counter(providerDaily,"providerDaily");
    pm=counter(providerMonthly,"providerMonthly");
    if(typeof providerObservedAt!=="string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(providerObservedAt) || !Number.isFinite(Date.parse(providerObservedAt)))
      throw Error("Provider observation must include a valid UTC ISO-8601 timestamp");
    observedAt=new Date(providerObservedAt);
    const reference=now instanceof Date?now:new Date(now);
    const ageMs=reference.getTime()-observedAt.getTime();
    if(!Number.isFinite(ageMs)||ageMs<0||ageMs>15*60*1000)
      throw Error("Provider observations must be no older than 15 minutes and cannot be in the future");
    const utcDay=d=>d.toISOString().slice(0,10);
    if(utcDay(observedAt)!==utcDay(reference))throw Error("Provider daily window is not current UTC date");
  }else if(providerObservedAt!==null){
    throw Error("Provider timestamp without provider counters");
  }
  const effectiveDaily=known?Math.max(ld,pd):ld;
  const effectiveMonthly=known?Math.max(lm,pm):lm;
  const utilization=Math.max(effectiveDaily/LIMITS.daily,effectiveMonthly/LIMITS.monthly);
  const status=utilization>=1?"exhausted":utilization>=0.95?"critical":utilization>=0.8?"warning":utilization>=0.5?"watch":"below-watch";
  return {
    status,
    accountVisibility:known?"provider-manual-observation":"account-total-unknown",
    local:{daily:ld,monthly:lm},
    provider:known?{daily:pd,monthly:pm,observedAt:observedAt.toISOString()}:null,
    observedGap:known?{daily:pd-ld,monthly:pm-lm}:null,
    conservativeObserved:{daily:effectiveDaily,monthly:effectiveMonthly},
    availableObserved:known?{daily:Math.max(0,LIMITS.daily-effectiveDaily),monthly:Math.max(0,LIMITS.monthly-effectiveMonthly)}:null,
    limits:LIMITS,
    notes:known?
      "Provider counters are a manual UTC observation; gap is provider minus locally reserved/sent/uncertain and is not proof of external sends. Recheck dashboard before sending.":
      "Only local reservations are visible; external sends and account-wide remaining quota are UNKNOWN. Do not interpret local headroom as provider availability."
  };
}
function readArgs(args) {
  const params={};
  for(const token of args){
    const m=/^--(local-daily|local-monthly|provider-daily|provider-monthly|provider-observed-at)=(.+)$/.exec(token);
    if(!m || Object.hasOwn(params,m[1]))throw Error("Invalid or repeated argument");
    params[m[1]]=m[2];
  }
  for(const field of ["local-daily","local-monthly"])if(!(field in params))throw Error("Missing "+field);
  const asInt=(name)=>params[name]===undefined?null:/^\d+$/.test(params[name])?Number(params[name]):NaN;
  return {localDaily:asInt("local-daily"),localMonthly:asInt("local-monthly"),
    providerDaily:asInt("provider-daily"),providerMonthly:asInt("provider-monthly"),
    providerObservedAt:params["provider-observed-at"]??null};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const result=evaluateQuota(readArgs(process.argv.slice(2)));
    console.log("P2 RESEND ACCOUNT RECONCILIATION: "+JSON.stringify(result));
    if(result.accountVisibility==="account-total-unknown")console.log("P2-02 PARTIAL: provider-account usage not verified; no external delta asserted.");
    else console.log("P2-02 OBSERVED: compare both UTC windows and reserve capacity; manual numbers are not live API attestation.");
  }catch(e){console.error("P2-02 BLOCKED: "+(e instanceof Error?e.message:String(e)));process.exitCode=2;}
}
