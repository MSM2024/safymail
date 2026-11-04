import test from "node:test";
import assert from "node:assert/strict";
import { sealCredentials, openCredentials, deriveMaintenanceToken } from "./provisioning-jobs";

const master = "vault-key-".repeat(5);
const credentials = {
  cloudflareApiToken: "cf-token-secret-value",
  cloudflareAccountId: "a".repeat(32),
  resendApiKey: "resend-secret-value"
};

test("provider credentials are encrypted and never appear in the stored envelope", async () => {
  const sealed = await sealCredentials(master, credentials, "installation-1:job-1");
  const serialized = JSON.stringify(sealed);
  assert.equal(serialized.includes(credentials.cloudflareApiToken), false);
  assert.equal(serialized.includes(credentials.resendApiKey), false);
  assert.deepEqual(await openCredentials(master, sealed.ciphertext, sealed.nonce, "installation-1:job-1"), credentials);
});

test("credential envelope is authenticated to its installation and job identity", async () => {
  const sealed = await sealCredentials(master, credentials, "installation-1:job-1");
  await assert.rejects(
    () => openCredentials(master, sealed.ciphertext, sealed.nonce, "installation-2:job-1")
  );
  await assert.rejects(
    () => openCredentials("different-vault-key".repeat(3), sealed.ciphertext, sealed.nonce, "installation-1:job-1")
  );
});

test("each credential envelope uses a fresh nonce", async () => {
  const first = await sealCredentials(master, credentials, "installation-1:job-1");
  const second = await sealCredentials(master, credentials, "installation-1:job-2");
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test("maintenance token is deterministic per installation and isolated across installations", async () => {
  const first = await deriveMaintenanceToken(master, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const repeat = await deriveMaintenanceToken(master, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const other = await deriveMaintenanceToken(master, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  assert.equal(first, repeat);
  assert.notEqual(first, other);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
});
