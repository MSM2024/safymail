import test from "node:test";
import assert from "node:assert/strict";
import { evaluateActivationReadiness, REQUIRED_ACTIVATION_STEPS } from "./activation-readiness";

const valid = () => ({
  status: "configuring", currentStep: "resources_ready",
  providerStatus: "active", completedSteps: [...REQUIRED_ACTIVATION_STEPS],
  webhookSecretConfigured: true, forwardedWebhookCount: 1
});

test("activation requires complete evidence", () => {
  const result = evaluateActivationReadiness(valid());
  assert.equal(result.readyForActivation, true);
  assert.equal(result.checks.checkpointCount, 5);
});
test("activation fails closed on missing checkpoints", () => {
  const input=valid();input.completedSteps.pop();
  const result=evaluateActivationReadiness(input);
  assert.equal(result.readyForActivation,false);
  assert.deepEqual(result.checks.missingCheckpoints, ["resend_webhook_ready"]);
});
test("activation refuses missing webhook evidence or signing secret", () => {
  assert.equal(evaluateActivationReadiness({...valid(),forwardedWebhookCount:0}).readyForActivation,false);
  assert.equal(evaluateActivationReadiness({...valid(),webhookSecretConfigured:false}).readyForActivation,false);
});
test("activation refuses wrong provider, state, and provisioning stage", () => {
  assert.equal(evaluateActivationReadiness({...valid(),providerStatus:"revoked"}).readyForActivation,false);
  assert.equal(evaluateActivationReadiness({...valid(),status:"ready"}).readyForActivation,false);
  assert.equal(evaluateActivationReadiness({...valid(),currentStep:"queued"}).readyForActivation,false);
});
