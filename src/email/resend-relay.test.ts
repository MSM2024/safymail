import assert from "node:assert/strict";
import test from "node:test";
import { sendViaResendRelay, diagnoseRelayConnectivity } from "./resend-relay";
import type { Env } from "../types";

test("relay uses internal service binding and preserves idempotency", async () => {
  let calls=0;
  const service = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      assert.match(String(input), /\/internal\/installations\/test-installation-123456\/resend\/send$/);
      assert.equal(init?.method,"POST");
      assert.equal(init?.redirect,"manual");
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

test("read-only relay diagnostic calls only health without tokens or send payload", async () => {
  const calls: string[] = [];
  const env = {
    CONTROL_PLANE_URL:"https://control.example.com",
    CONTROL_PLANE_SERVICE:{
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(input));
        assert.equal(init?.method,"GET");
        assert.equal(init?.redirect,"manual");
        assert.equal(new Headers(init?.headers).has("Authorization"),false);
        return new Response(JSON.stringify({status:"ok",service:"mail-center-control-plane"}),{status:200});
      }
    }
  } as unknown as Env;
  assert.deepEqual(await diagnoseRelayConnectivity(env),{reachable:true,bindingPresent:true,status:200});
  assert.deepEqual(calls,["https://control.example.com/health"]);
});

test("read-only relay diagnostic classifies binding network errors without leaking details", async () => {
  const env = {
    CONTROL_PLANE_URL:"https://control.example.com",
    CONTROL_PLANE_SERVICE:{ fetch: async () => {throw new TypeError("sensitive internal details");} }
  } as unknown as Env;
  assert.deepEqual(await diagnoseRelayConnectivity(env),{reachable:false,bindingPresent:true,errorType:"type_error"});
});

test("relay never treats redirects as provider acceptance", async () => {
  const env = {
    CONTROL_PLANE_URL: "https://control.example.com",
    INSTALLATION_ID: "test-installation-123456",
    RESEND_RELAY_TOKEN: "secret-value",
    CONTROL_PLANE_SERVICE: {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(init?.redirect, "manual");
        return new Response(null, {status: 302, headers: {Location: "https://untrusted.example"}});
      }
    }
  } as unknown as Env;
  assert.deepEqual(await sendViaResendRelay(env, {}, "mail-test-123"), {
    ok: false, status: 302, error: "resend_relay_failed"
  });
});
