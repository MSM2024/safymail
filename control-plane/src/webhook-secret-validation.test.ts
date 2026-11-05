import test from "node:test";
import assert from "node:assert/strict";
import { isValidResendWebhookSecret } from "./webhook-secret-validation";

test("accepts Resend standard Base64 including plus slash and padding", () => {
  const key = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i === 0 ? 251 : i === 1 ? 255 : i));
  const raw = btoa(String.fromCharCode(...key));
  assert.ok(raw.includes("+") || raw.includes("/"));
  assert.equal(isValidResendWebhookSecret("whsec_" + raw), true);
});
test("rejects malformed, truncated and base64url input", () => {
  for (const secret of ["whsec_123", "whsec_" + "x".repeat(20) + "!", "whsec_ " + "A".repeat(24), "wrong_" + "A".repeat(24), "whsec_" + "A".repeat(12), "whsec_" + "A".repeat(21) + "-", "whsec_" + "A".repeat(21) + "_"]) {
    assert.equal(isValidResendWebhookSecret(secret), false);
  }
});
