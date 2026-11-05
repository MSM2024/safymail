import test from "node:test";
import assert from "node:assert/strict";
import { RECORD_FAILED_LOGIN_SQL, recordFailedLogin } from "./login-throttle";

test("failed login is recorded as a single atomic upsert", async () => {
  const calls: {sql:string;values:unknown[]}[]=[];
  const fakeDb={
    prepare(sql:string){
      return {bind(...values:unknown[]){
        calls.push({sql,values});
        return {run:async()=>({success:true})};
      }};
    }
  } as unknown as D1Database;
  const now=new Date("2026-11-05T03:15:00.000Z");
  await recordFailedLogin(fakeDb,"ip-hash","user@example.com",now);
  assert.equal(calls.length,1);
  assert.match(calls[0].sql,/ON CONFLICT\(ip_hash,email\) DO UPDATE SET/);
  assert.match(calls[0].sql,/failed_count \+ 1/);
  assert.match(calls[0].sql,/failed_count >= 7/);
  assert.match(calls[0].sql,/ELSE excluded\.window_started_at/);
  assert.deepEqual(calls[0].values,[
    "ip-hash","user@example.com","2026-11-05T03:15:00.000Z",
    "2026-11-05T03:00:00.000Z","2026-11-05T03:00:00.000Z",
    "2026-11-05T03:30:00.000Z","2026-11-05T03:00:00.000Z"
  ]);
});
test("SQL handles first failure and resets expired windows without application-side counters",()=>{
  assert.match(RECORD_FAILED_LOGIN_SQL,/VALUES \(\?,\?,1,\?,NULL\)/);
  assert.match(RECORD_FAILED_LOGIN_SQL,/WHEN window_started_at > \? THEN failed_count \+ 1 ELSE 1 END/);
  assert.match(RECORD_FAILED_LOGIN_SQL,/WHEN window_started_at > \? AND failed_count >= 7 THEN \?/);
});
