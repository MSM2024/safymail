import test from "node:test";
import assert from "node:assert/strict";
import { verifyResendWebhook } from "./webhooks";

const secretBytes = new TextEncoder().encode("local-test-secret");
const secret = "whsec_" + btoa(String.fromCharCode(...secretBytes));

async function signedRequest(body: string, timestampSeconds: number, signatureBody = body) {
  const id = "evt_test_123";
  const timestamp = String(timestampSeconds);
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = new TextEncoder().encode(id + "." + timestamp + "." + signatureBody);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  const signature = btoa(String.fromCharCode(...digest));
  return new Request("https://mail.example.test/api/webhooks/resend", {
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": "v1," + signature
    }
  });
}

test("accepts a valid, recent Svix signature", async () => {
  const now = Date.now();
  const body = JSON.stringify({ type: "email.delivered" });
  const request = await signedRequest(body, Math.floor(now / 1000));
  assert.equal(await verifyResendWebhook(body, request, secret, now), true);
});

test("rejects altered payloads and stale webhook signatures", async () => {
  const now = Date.now();
  const body = JSON.stringify({ type: "email.sent" });
  const altered = await signedRequest(body, Math.floor(now / 1000));
  assert.equal(await verifyResendWebhook(body + " ", altered, secret, now), false);

  const stale = await signedRequest(body, Math.floor(now / 1000) - 301);
  assert.equal(await verifyResendWebhook(body, stale, secret, now), false);
});

test("rejects malformed timestamps and invalid signature headers", async () => {
  const now = Date.now();
  const body = "{}";
  const request = new Request("https://mail.example.test/api/webhooks/resend", {
    headers: { "svix-id": "evt_test_123", "svix-timestamp": "not-a-timestamp", "svix-signature": "v1,invalid" }
  });
  assert.equal(await verifyResendWebhook(body, request, secret, now), false);
});
