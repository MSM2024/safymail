import { resolveMailWebhookRoute } from "./webhook-forwarding";
import { deriveMaintenanceTokens } from "./provisioning-jobs";

export interface MaintenanceJobEnv {
  CONTROL_DB: D1Database;
  CONTROL_PLANE_VAULT_KEY: string;
  MAIL_DELIVERY_SERVICE?: Fetcher;
  MAIL_DELIVERY_DOMAIN?: string;
  MAIL_DELIVERY_HOST?: string;
}

export async function processMaintenanceBatch(env: MaintenanceJobEnv, installationIds: string[], slot: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:(?:00|15|30|45):00\.000Z$/.test(slot) || !Array.isArray(installationIds) || installationIds.length < 1 || installationIds.length > 10) {
    throw new Error("Invalid maintenance batch.");
  }
  const placeholders = installationIds.map(() => "?").join(",");
  const rows = await env.CONTROL_DB.prepare(
    "SELECT id,domain FROM control_installations WHERE status='ready' AND id IN (" + placeholders + ")"
  ).bind(...installationIds).all<{ id: string; domain: string }>();
  const installations = rows.results || [];
  const tokens = await deriveMaintenanceTokens(env.CONTROL_PLANE_VAULT_KEY, installations.map(item => item.id));
  const outcomes = await Promise.all(installations.map(async (installation, index) => {
    const token = tokens[index];
    const route = resolveMailWebhookRoute(installation.domain, env.MAIL_DELIVERY_DOMAIN, env.MAIL_DELIVERY_HOST);
    const endpoint = new URL("/api/internal/maintenance", route.url);
    const sender = route.useBinding && env.MAIL_DELIVERY_SERVICE
      ? env.MAIL_DELIVERY_SERVICE.fetch.bind(env.MAIL_DELIVERY_SERVICE)
      : fetch;
    const response = await sender(endpoint.toString(), {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "X-Mail-Center-Scheduler-Slot": slot },
      body: "{}",
      redirect: "manual",
      signal: AbortSignal.timeout(10000)
    });
    return response.ok;
  }));
  if (outcomes.some(ok => !ok)) throw new Error("One or more mail Workers did not complete scheduled maintenance.");
}
