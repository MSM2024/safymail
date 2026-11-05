import assert from "node:assert/strict";
import test from "node:test";
import { sendViaResendRelay } from "./resend-relay";
import type { Env } from "../types";

test("relay uses internal service binding and preserves idempotency", async () => {
  let calls=0;
  const service = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      assert.match(String(input), /\/internal\/installations\/test-installation-123456\/resend\/send$/);
      assert.equal(init?.method,"POST");
      assert.equal(new Headers(init?.headers).get("Idempotency-Key"),"mail-test-123");
      return new Response(JSON.stringify({id:"provider-123"}),{status:200,headers:{"Content-Type":"application/json"}});
    }
  };
  const env = {
    CONTROL_PLANE_URL:"https://control.example.com",
    INSTALLATION_ID:"test-installation-123456",
    RESEND_RELAY_TOKEN:"secret-value",
    CONTROL_PLANE_SERVICE:service
  } as unknown as Env;
  const result = await sendViaResendRelay(env,{from:"ceo@example.com",to:["test@example.com"],subject:"test",text:"hello"},"mail-test-123");
  assert.deepEqual(result,{ok:true,status:200,providerId:"provider-123"});
  assert.equal(calls,1);
});

test("relay returns transport error if service binding rejects", async () => {
  const env={CONTROL_PLANE_URL:"https://control.example.com",INSTALLATION_ID:"test-installation-123456",RESEND_RELAY_TOKEN:"secret-value",CONTROL_PLANE_SERVICE:{fetch:async()=>{throw new Error("connection failed")}}} as unknown as Env;
  assert.deepEqual(await sendViaResendRelay(env,{},"mail-test-123"),{ok:false,status:503,error:"resend_relay_unavailable"});
});
