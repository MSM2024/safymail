import test from "node:test";
import assert from "node:assert/strict";
import { evaluateQuota } from "./p2-resend-quota-reconcile.mjs";

const now=new Date("2026-11-05T18:30:00.000Z");
const observed="2026-11-05T18:25:00.000Z";
test("unknown external account usage remains explicitly unknown",()=>{
  const result=evaluateQuota({localDaily:3,localMonthly:3,now});
  assert.equal(result.accountVisibility,"account-total-unknown");
  assert.equal(result.availableObserved,null);
  assert.equal(result.observedGap,null);
  assert.equal(result.status,"below-watch");
});
test("manual account observation reconciles both windows without inventing external send counts",()=>{
  const result=evaluateQuota({localDaily:3,localMonthly:7,providerDaily:8,providerMonthly:25,providerObservedAt:observed,now});
  assert.equal(result.accountVisibility,"provider-manual-observation");
  assert.deepEqual(result.observedGap,{daily:5,monthly:18});
  assert.deepEqual(result.availableObserved,{daily:92,monthly:2975});
  assert.match(result.notes,/not proof of external sends/);
});
test("conservative metric uses maximum of reservation ledger and provider totals",()=>{
  const result=evaluateQuota({localDaily:98,localMonthly:2200,providerDaily:90,providerMonthly:2000,providerObservedAt:observed,now});
  assert.equal(result.status,"critical");
  assert.equal(result.observedGap.daily,-8);
  assert.deepEqual(result.conservativeObserved,{daily:98,monthly:2200});
});
test("thresholds apply to either UTC window and account daily/monthly together",()=>{
  const base={providerObservedAt:observed,now};
  assert.equal(evaluateQuota({...base,localDaily:1,localMonthly:2990,providerDaily:1,providerMonthly:2990}).status,"critical");
  assert.equal(evaluateQuota({...base,localDaily:80,localMonthly:10,providerDaily:80,providerMonthly:10}).status,"warning");
  assert.equal(evaluateQuota({...base,localDaily:100,localMonthly:10,providerDaily:100,providerMonthly:10}).status,"exhausted");
  assert.equal(evaluateQuota({...base,localDaily:1,localMonthly:1500,providerDaily:1,providerMonthly:1500}).status,"watch");
});
test("fails closed for partial, stale, future, non-UTC or malformed provider observations",()=>{
  const basic={localDaily:2,localMonthly:2,now};
  assert.throws(()=>evaluateQuota({...basic,providerDaily:2}),/Both provider/);
  assert.throws(()=>evaluateQuota({...basic,providerDaily:2,providerMonthly:2}),/timestamp/);
  assert.throws(()=>evaluateQuota({...basic,providerDaily:2,providerMonthly:2,providerObservedAt:"2026-11-05T18:25:00-00:00"}),/UTC/);
  assert.throws(()=>evaluateQuota({...basic,providerDaily:2,providerMonthly:2,providerObservedAt:"2026-11-05T17:00:00Z"}),/15 minutes/);
  assert.throws(()=>evaluateQuota({...basic,providerDaily:2,providerMonthly:2,providerObservedAt:"2026-11-05T18:31:00Z"}),/future/);
  assert.throws(()=>evaluateQuota({...basic,providerDaily:2,providerMonthly:2,providerObservedAt:"2026-11-04T23:59:00Z"}),/15 minutes/);
  assert.throws(()=>evaluateQuota({...basic,localDaily:-1}),/nonnegative/);
});
