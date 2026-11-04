import test from "node:test";
import assert from "node:assert/strict";
import { assessCatchAll } from "./email-routing-plan";

test("catch-all planner accepts an already enabled route to the intended Worker", () => {
  assert.equal(assessCatchAll({ enabled: true, actions: [{ type: "worker", value: ["mail-center"] }] }, "mail-center"), "already_configured");
});

test("catch-all planner refuses to replace an enabled route to another destination", () => {
  assert.equal(assessCatchAll({ enabled: true, actions: [{ type: "forward", value: ["existing@example.net"] }] }, "mail-center"), "conflict");
});

test("catch-all planner allows an absent or disabled default drop rule to be explicitly created", () => {
  assert.equal(assessCatchAll(null, "mail-center"), "create");
  assert.equal(assessCatchAll({ enabled: false, actions: [{ type: "drop" }] }, "mail-center"), "create");
  assert.equal(assessCatchAll({ enabled: false, actions: [] }, "mail-center"), "create");
});

test("catch-all planner refuses to replace a disabled non-default route", () => {
  assert.equal(assessCatchAll({ enabled: false, actions: [{ type: "forward", value: ["existing@example.net"] }] }, "mail-center"), "conflict");
  assert.equal(assessCatchAll({ enabled: false, actions: [{ type: "worker", value: ["another-worker"] }] }, "mail-center"), "conflict");
});

test("catch-all planner validates Worker names", () => {
  assert.throws(() => assessCatchAll(null, "../unsafe"), /Invalid Worker name/);
});
