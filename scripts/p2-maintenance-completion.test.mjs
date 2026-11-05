import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMaintenance } from "./p2-maintenance-completion.mjs";

const latest="2026-11-05T19:00:00.000Z";
const earlier="2026-11-05T18:45:00.000Z";
const now=new Date("2026-11-05T19:11:17Z");
test("same claimed and completed slot with low age is observed healthy, not queue certification",()=>{
 const result=evaluateMaintenance({dispatchedSlot:latest,completedSlot:latest,lockActive:0,now});
 assert.equal(result.status,"observed-healthy");
 assert.equal(result.backlogSlots,0);
 assert.equal(result.dispatchAgeMinutes,11.3);
 assert.match(result.note,/remain UNKNOWN/);
});
test("incomplete claimed slot and stale completion produce explicit alert",()=>{
 const result=evaluateMaintenance({dispatchedSlot:latest,completedSlot:earlier,lockActive:0,now});
 assert.equal(result.status,"alert");
 assert.equal(result.backlogSlots,1);
 assert.equal(evaluateMaintenance({dispatchedSlot:"2026-11-05T18:30:00.000Z",completedSlot:"2026-11-05T18:30:00.000Z",lockActive:0,now}).status,"alert");
});
test("missing or implausible timestamps and invalid lock never PASS",()=>{
 const base={dispatchedSlot:latest,completedSlot:latest,lockActive:0,now};
 assert.equal(evaluateMaintenance({...base,completedSlot:"not-recorded"}).status,"unknown");
 assert.equal(evaluateMaintenance({...base,lockActive:2}).status,"unknown");
 assert.equal(evaluateMaintenance({...base,dispatchedSlot:earlier,completedSlot:latest}).status,"unknown");
 assert.equal(evaluateMaintenance({...base,now:new Date("2026-11-05T18:00:00Z")}).status,"alert");
});
