import { pathToFileURL } from "node:url";
import path from "node:path";

export function evaluateMaintenance({dispatchedSlot,completedSlot,lockActive,now=new Date()}) {
  const stamp = value => typeof value==="string" && /^\d{4}-\d{2}-\d{2}T\d{2}:(?:00|15|30|45):00\.000Z$/.test(value) && !Number.isNaN(Date.parse(value));
  if (!stamp(dispatchedSlot) || !stamp(completedSlot)) return {status:"unknown",reason:"missing-or-malformed-slot"};
  if (![0,1].includes(lockActive)) return {status:"unknown",reason:"unknown-lock"};
  const nowMs=now instanceof Date?now.getTime():Date.parse(now);
  if(!Number.isFinite(nowMs))return {status:"unknown",reason:"invalid-clock"};
  const dispatchMs=Date.parse(dispatchedSlot),completeMs=Date.parse(completedSlot);
  if(dispatchMs>nowMs+60000 || completeMs>nowMs+60000)return {status:"alert",reason:"slot-in-future"};
  if(completeMs>dispatchMs)return {status:"unknown",reason:"completion-ahead-of-dispatch"};
  const dispatchAgeMinutes=Math.round(((nowMs-dispatchMs)/60000)*10)/10;
  const completionAgeMinutes=Math.round(((nowMs-completeMs)/60000)*10)/10;
  const backlogSlots=Math.round((dispatchMs-completeMs)/900000);
  const status=backlogSlots>0 || dispatchAgeMinutes>30 || completionAgeMinutes>30?"alert":"observed-healthy";
  return {
    status,
    dispatchedSlot,completedSlot,lockActive,dispatchAgeMinutes,completionAgeMinutes,backlogSlots,
    note:"Only latest claimed/completed slot from D1. Queue depth, delivery retries and DLQ status remain UNKNOWN."
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const [dispatchedSlot,completedSlot,lock]=process.argv.slice(2);
    if(![dispatchedSlot,completedSlot,lock].every(v=>v!==undefined))throw Error("provide dispatch slot, completed slot and lock active (0 or 1)");
    const result=evaluateMaintenance({dispatchedSlot,completedSlot,lockActive:Number(lock)});
    console.log("P2 MAINTENANCE COMPLETION: "+JSON.stringify(result));
    if(result.status!=="observed-healthy")process.exitCode=1;
  }catch(error){console.error("P2 MAINTENANCE UNKNOWN: "+(error instanceof Error?error.message:String(error)));process.exitCode=2;}
}
