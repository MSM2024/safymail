import test from "node:test";
import assert from "node:assert/strict";
import { decryptTotpSecret, encryptTotpSecret, generateBackupCodes, hashBackupCode, matchTotpCounter, verifyTotp } from "./totp";

test("TOTP matches RFC 6238 SHA-1 six-digit vector", async () => {
  assert.equal(await verifyTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "287082", 59_000), true);
});

test("TOTP counters prevent reuse of an accepted time step", async () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(await matchTotpCounter(secret, "287082", 59_000, -1), 1);
  assert.equal(await matchTotpCounter(secret, "287082", 59_000, 1), null);
});

test("TOTP rejects malformed and incorrect codes", async () => {
  assert.equal(await verifyTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "12345", 59_000), false);
  assert.equal(await verifyTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "000000", 59_000), false);
});

test("TOTP secret encryption round-trips and rejects tampering", async () => {
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const encrypted = await encryptTotpSecret("JBSWY3DPEHPK3PXP", key);
  assert.equal(await decryptTotpSecret(encrypted, key), "JBSWY3DPEHPK3PXP");
  const bytes = Uint8Array.from(atob(encrypted.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - encrypted.length % 4) % 4)), c => c.charCodeAt(0));
  bytes[bytes.length - 1] ^= 1;
  const tampered = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  await assert.rejects(() => decryptTotpSecret(tampered, key));
});

test("backup codes are unique and stored as one-way hashes", async () => {
  const codes = generateBackupCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.equal(codes.every(code => /^[A-F0-9]{16}$/.test(code)), true);
  assert.equal(await hashBackupCode(codes[0]), await hashBackupCode(codes[0]));
});
