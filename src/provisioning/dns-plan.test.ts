import test from "node:test";
import assert from "node:assert/strict";
import { buildDnsPlan } from "./dns-plan";

test("DNS planner identifies exact records without proposing changes", () => {
  const plan = buildDnsPlan("example.com", [
    { type: "TXT", name: "send", value: "v=spf1 include:amazonses.com ~all" },
    { type: "MX", name: "send", value: "feedback-smtp.eu-west-1.amazonses.com", priority: 10 }
  ], [
    { type: "TXT", name: "send.example.com", content: "v=spf1 include:amazonses.com ~all" },
    { type: "MX", name: "send.example.com", content: "feedback-smtp.eu-west-1.amazonses.com", priority: 10 }
  ]);
  assert.deepEqual(plan.map(item => item.action), ["present", "present"]);
});

test("DNS planner proposes only missing records and never edits existing records", () => {
  const plan = buildDnsPlan("example.com", [
    { type: "CNAME", name: "mail", value: "verify.resend.com", ttl: "Auto" },
    { type: "TXT", name: "resend-verification", value: "resend-verification=abc" }
  ], [
    { type: "TXT", name: "old-verification.example.com", content: "existing-verification=xyz" }
  ]);
  assert.deepEqual(plan.map(item => item.action), ["create", "create"]);
  assert.equal(plan[0].ttl, 1);
});

test("DNS planner refuses to replace a different SPF record", () => {
  const plan = buildDnsPlan("example.com", [
    { type: "TXT", name: "@", value: "v=spf1 include:resend.com ~all" }
  ], [
    { type: "TXT", name: "example.com", content: "v=spf1 include:_spf.google.com ~all" }
  ]);
  assert.equal(plan[0].action, "manual");
  assert.match(plan[0].reason || "", /SPF record already exists/);
});

test("DNS planner refuses to replace an existing MX record", () => {
  const plan = buildDnsPlan("example.com", [
    { type: "MX", name: "example.com", value: "inbound.example.net", priority: 10 }
  ], [
    { type: "MX", name: "example.com", content: "mx1.mailhost.net", priority: 5 }
  ]);
  assert.equal(plan[0].action, "manual");
  assert.match(plan[0].reason || "", /MX record already exists/);
});

test("DNS planner refuses CNAME creation over an existing A record", () => {
  const plan = buildDnsPlan("example.com", [
    { type: "CNAME", name: "mail", value: "mail-provider.example.net" }
  ], [
    { type: "A", name: "mail.example.com", content: "192.0.2.10" }
  ]);
  assert.equal(plan[0].action, "manual");
  assert.match(plan[0].reason || "", /CNAME cannot safely coexist/);
});

test("DNS planner refuses to replace existing DKIM and DMARC values", () => {
  const plan = buildDnsPlan("example.com", [
    { type: "TXT", name: "resend._domainkey", value: "p=new-key" },
    { type: "TXT", name: "_dmarc", value: "v=DMARC1; p=reject" }
  ], [
    { type: "TXT", name: "resend._domainkey.example.com", content: "p=existing-key" },
    { type: "TXT", name: "_dmarc.example.com", content: "v=DMARC1; p=quarantine" }
  ]);
  assert.deepEqual(plan.map(item => item.action), ["manual", "manual"]);
});

test("DNS planner rejects malformed domains and unsupported records", () => {
  assert.throws(() => buildDnsPlan("not a domain", [], []), /Invalid DNS plan domain/);
  assert.throws(() => buildDnsPlan("example.com", [{ type: "SSHFP", name: "@", value: "x" }], []), /Unsupported/);
});
