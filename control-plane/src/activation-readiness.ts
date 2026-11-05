export interface ActivationReadiness {
  status: string;
  currentStep: string;
  providerStatus: string | null;
  completedSteps: string[];
  webhookSecretConfigured: boolean;
  forwardedWebhookCount: number;
}
export const REQUIRED_ACTIVATION_STEPS = [
  "cloudflare_verified", "d1_ready", "kv_ready", "resend_domain_ready", "resend_webhook_ready"
] as const;

export function evaluateActivationReadiness(input: ActivationReadiness) {
  const done = new Set(input.completedSteps);
  const missingCheckpoints = REQUIRED_ACTIVATION_STEPS.filter(step => !done.has(step));
  const checks = {
    provisioned: input.currentStep === "resources_ready",
    providerActive: input.providerStatus === "active",
    checkpointCount: REQUIRED_ACTIVATION_STEPS.length - missingCheckpoints.length,
    missingCheckpoints,
    webhookSecretConfigured: input.webhookSecretConfigured,
    verifiedWebhookDeliveries: input.forwardedWebhookCount
  };
  return {
    readyForActivation: input.status === "configuring" &&
      checks.provisioned && checks.providerActive &&
      !checks.missingCheckpoints.length && checks.webhookSecretConfigured &&
      checks.verifiedWebhookDeliveries > 0,
    checks
  };
}
