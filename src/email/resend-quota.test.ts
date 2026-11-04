import test from "node:test";
import assert from "node:assert/strict";
import { getResendQuotaState } from "./resend-quota";

test("Resend Free daily cap defers messages until next UTC day", () => {
  const state = getResendQuotaState(new Date("2026-11-03T16:45:00.000Z"), 100, 1200);
  assert.equal(state.allowed, false);
  assert.equal(state.reason, "daily_limit");
  assert.equal(state.retryAt, "2026-11-04T00:00:00.000Z");
});

test("Resend Free monthly cap takes precedence over daily reset", () => {
  const state = getResendQuotaState(new Date("2026-11-30T23:45:00.000Z"), 100, 3000);
  assert.equal(state.allowed, false);
  assert.equal(state.reason, "monthly_limit");
  assert.equal(state.retryAt, "2026-12-01T00:00:00.000Z");
});

test("Resend Free quota permits sends below both caps", () => {
  const state = getResendQuotaState(new Date("2026-11-03T16:45:00.000Z"), 99, 2999);
  assert.equal(state.allowed, true);
  assert.equal(state.retryAt, null);
});
