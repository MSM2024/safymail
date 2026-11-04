import { CloudflareClient } from "./cloudflare";
import { ResendClient } from "./resend";

export interface ProvisioningInput {
  installationId: string;
  providerAccountId: string;
  appName: string;
  workerName: string;
  domain: string;
  resendRegion: string;
  webhookEndpoint: string;
  managedDomainCount: number;
  cloudflare: { accountId: string; apiToken: string };
  resend: { apiKey: string; existingWebhookSecret?: string };
  onSecret: (name: "RESEND_WEBHOOK_SECRET", value: string) => Promise<void>;
  onCheckpoint: (step: "cloudflare_verified" | "d1_ready" | "kv_ready" | "resend_domain_ready" | "resend_webhook_ready", details: Record<string, unknown>) => Promise<void>;
}
export interface ProvisioningResult {
  installationId: string;
  status: "resources_ready";
  resources: {
    zone: { id: string; name: string; status: string };
    d1: { id: string; name: string; created: boolean };
    kv: { id: string; title: string; created: boolean };
    resendDomain: { id: string; name: string; created: boolean; records: unknown[] };
    resendWebhook: { id: string; endpoint: string; created: boolean };
  };
  next: "configure_worker_and_dns";
}

function safeSlug(value: string): string {
  const slug = value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  if (!slug || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) throw new Error("Invalid installation slug.");
  return slug;
}

export async function provisionCoreResources(input: ProvisioningInput): Promise<ProvisioningResult> {
  if (!/^[a-f0-9-]{16,64}$/i.test(input.installationId)) throw new Error("Invalid installation ID.");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(input.workerName)) throw new Error("Invalid Worker name.");
  const domain = input.domain.toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error("Invalid domain.");

  if (typeof input.onSecret !== "function" || typeof input.onCheckpoint !== "function") throw new Error("Secure secret storage and durable checkpoint callbacks are required before provisioning can begin.");
  let webhookUrl: URL;
  try { webhookUrl = new URL(input.webhookEndpoint); } catch { throw new Error("Invalid webhook endpoint URL."); }
  if (webhookUrl.protocol !== "https:" || webhookUrl.username || webhookUrl.password || webhookUrl.search || webhookUrl.hash || webhookUrl.pathname !== "/webhooks/resend/" + input.providerAccountId) {
    throw new Error("Webhook endpoint must use the HTTPS shared control-plane route for this installation's provider account.");
  }
  const slug = safeSlug(input.workerName);
  const d1Name = slug + "-db";
  const kvTitle = slug + "-mail-storage";
  const cf = new CloudflareClient(input.cloudflare);
  const resend = new ResendClient(input.resend);

  await cf.verifyToken();
  const zone = await cf.findZone(domain);
  if (!zone) throw new Error("domain_zone_not_found");
  if (zone.status !== "active") throw new Error("domain_zone_not_active");
  await input.onCheckpoint("cloudflare_verified", { accountId: input.cloudflare.accountId, zoneId: zone.id, zoneStatus: zone.status });
  // Free-tier preflight is completed for every provider before the first
  // resource-creating request. It deliberately fails closed on known limits.
  await cf.assertFreeCapacity(d1Name, input.workerName, kvTitle);
  await resend.assertFreeCapacity(domain, input.webhookEndpoint, input.managedDomainCount);
  const d1 = await cf.ensureD1(d1Name);
  await input.onCheckpoint("d1_ready", { id: d1.database.uuid, name: d1.database.name, created: d1.created });
  const kv = await cf.ensureKvNamespace(kvTitle);
  await input.onCheckpoint("kv_ready", { id: kv.namespace.id, title: kv.namespace.title, created: kv.created });
  const resendDomain = await resend.ensureDomain(domain, input.resendRegion);
  await input.onCheckpoint("resend_domain_ready", { id: resendDomain.domain.id, name: resendDomain.domain.name, created: resendDomain.created, records: resendDomain.domain.records || [] });
  const webhook = await resend.ensureWebhook(input.webhookEndpoint, [
    "email.sent", "email.delivered", "email.bounced", "email.failed"
  ], input.resend.existingWebhookSecret);
  await input.onSecret("RESEND_WEBHOOK_SECRET", webhook.signingSecret);
  await input.onCheckpoint("resend_webhook_ready", { id: webhook.webhook.id, endpoint: webhook.webhook.endpoint, created: webhook.created });

  return {
    installationId: input.installationId,
    status: "resources_ready",
    resources: {
      zone,
      d1: { id: d1.database.uuid, name: d1.database.name, created: d1.created },
      kv: { id: kv.namespace.id, title: kv.namespace.title, created: kv.created },
      resendDomain: { id: resendDomain.domain.id, name: resendDomain.domain.name, created: resendDomain.created, records: resendDomain.domain.records || [] },
      resendWebhook: { id: webhook.webhook.id, endpoint: webhook.webhook.endpoint, created: webhook.created }
    },
    next: "configure_worker_and_dns"
  };
}
