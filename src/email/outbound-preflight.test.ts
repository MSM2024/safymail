import assert from "node:assert/strict";
import test from "node:test";
import { getOutboundPreflight } from "./outbound-preflight";

const ready = {
  CONTROL_PLANE_URL: "https://control.example.com",
  INSTALLATION_ID: "12345678-abcd-4321-9988-1234567890ab",
  RESEND_RELAY_TOKEN: "secret-token-must-never-be-in-response"
};
test("preflight accepts configured HTTPS relay without exposing credentials", () => {
  const result = getOutboundPreflight(ready);
  assert.deepEqual(result, {ready:true,transport:"resend_relay",reason:"ready_for_attempt"});
  assert.ok(!JSON.stringify(result).includes("secret-token"));
  assert.ok(!JSON.stringify(result).includes("control.example.com"));
});
test("preflight fails closed for missing token, URL and installation", () => {
  for (const field of Object.keys(ready) as Array<keyof typeof ready>) {
    assert.equal(getOutboundPreflight({...ready,[field]:""}).reason,"relay_not_configured");
  }
});
test("preflight rejects HTTP remote targets and credential URLs", () => {
  for (const url of [
    "http://relay.example.com","ftp://relay.example.com",
    "https://user:password@relay.example.com",
    "https://relay.example.com/?apiKey=secret",
    "https://relay.example.com/#fragment","not a url"
  ]) {
    assert.deepEqual(getOutboundPreflight({...ready,CONTROL_PLANE_URL:url}),
      {ready:false,transport:"resend_relay",reason:"relay_url_invalid"});
  }
});
test("preflight permits local test HTTP only on loopback", () => {
  assert.equal(getOutboundPreflight({...ready,CONTROL_PLANE_URL:"http://127.0.0.1:8787"}).ready,true);
  assert.equal(getOutboundPreflight({...ready,CONTROL_PLANE_URL:"http://localhost:8787"}).ready,true);
});
