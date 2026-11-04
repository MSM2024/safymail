import test from "node:test";
import assert from "node:assert/strict";
import { assessWorkerDomain, hasDnsConflictForCustomDomain, hasWorkerRouteConflict } from "./custom-domain-plan";

const host = "mail.example.com";
const zone = "a".repeat(32);

test("custom domain planner recognizes the intended existing attachment", () => {
  assert.equal(assessWorkerDomain({ hostname: host, service: "mail-center", zone_id: zone, enabled: true }, host, "mail-center", zone), "already_configured");
});

test("custom domain planner refuses to take over another Worker attachment", () => {
  assert.equal(assessWorkerDomain({ hostname: host, service: "legacy-app", zone_id: zone, enabled: true }, host, "mail-center", zone), "conflict");
});

test("custom domain planner refuses a disabled or wrong-zone attachment", () => {
  assert.equal(assessWorkerDomain({ hostname: host, service: "mail-center", zone_id: zone, enabled: false }, host, "mail-center", zone), "conflict");
  assert.equal(assessWorkerDomain({ hostname: host, service: "mail-center", zone_id: "b".repeat(32), enabled: true }, host, "mail-center", zone), "conflict");
});

test("custom domain planner permits creation only when no attachment exists", () => {
  assert.equal(assessWorkerDomain(null, host, "mail-center", zone), "create");
});

test("custom domain planner rejects malformed inputs", () => {
  assert.throws(() => assessWorkerDomain(null, "not a hostname", "mail-center", zone), /Invalid custom-domain hostname/);
  assert.throws(() => assessWorkerDomain(null, host, "../worker", zone), /Invalid Worker name/);
});

test("DNS conflict detection treats any existing record at the hostname as a blocker", () => {
  assert.equal(hasDnsConflictForCustomDomain(host, [{ type: "A", name: host }]), true);
  assert.equal(hasDnsConflictForCustomDomain(host, [{ type: "CNAME", name: "mail.example.com." }]), true);
  assert.equal(hasDnsConflictForCustomDomain(host, [{ type: "TXT", name: "example.com" }]), false);
});

test("custom domain planner blocks exact Worker routes", () => {
  assert.equal(hasWorkerRouteConflict(host, [{ pattern: "mail.example.com/*" }]), true);
  assert.equal(hasWorkerRouteConflict(host, [{ pattern: "mail.example.com/api/*" }]), true);
});

test("custom domain planner blocks wildcard Worker routes that cover the hostname", () => {
  assert.equal(hasWorkerRouteConflict(host, [{ pattern: "*.example.com/*" }]), true);
  assert.equal(hasWorkerRouteConflict(host, [{ pattern: "*.other.example.com/*" }]), false);
});

test("custom domain planner allows unrelated Worker routes", () => {
  assert.equal(hasWorkerRouteConflict(host, [{ pattern: "www.example.com/*" }]), false);
  assert.equal(hasWorkerRouteConflict(host, [{ pattern: "example.net/*" }]), false);
});

test("custom domain planner fails closed on an unparseable route", () => {
  assert.equal(hasWorkerRouteConflict(host, [{ pattern: "" }]), true);
});
