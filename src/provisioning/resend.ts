import { ProviderError } from "./cloudflare";

export interface ResendConfig { apiKey: string; region?: string; fetcher?: typeof fetch; }
export interface ResendDomain {
  id: string;
  name: string;
  status?: string;
  region?: string;
  records?: Array<{ record: string; name: string; type: string; value: string; ttl?: string; priority?: number; status?: string }>;
}
export interface ResendWebhook { id: string; endpoint: string; events: string[]; signing_secret?: string; }
type ResendList<T> = { data: T[] };
type ResendItem<T> = { data: T };

export class ResendClient {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  constructor(private readonly config: ResendConfig) {
    if (!config.apiKey || config.apiKey.length < 20) throw new Error("Resend API key is missing or invalid.");
    // Keep the Workers global fetch receiver; a bare fetch stored on this class can throw TypeError.
    this.fetcher = config.fetcher || ((input, init) => globalThis.fetch(input, init));
    this.baseUrl = config.region === "eu-west-1" ? "https://api.resend.com" : "https://api.resend.com";
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(this.baseUrl + path, {
      ...init,
      headers: { Authorization: "Bearer " + this.config.apiKey, "Content-Type": "application/json", ...init.headers }
    });
    const payload = await response.json().catch(() => null) as (T & { message?: string }) | null;
    if (!response.ok || !payload) {
      const message = payload && typeof payload.message === "string" ? payload.message : "Resend API request failed.";
      throw new ProviderError(message, "resend", response.status, response.status === 429 || response.status >= 500);
    }
    return payload;
  }

  async verifyKey(): Promise<void> { await this.request<{ id?: string }>("/api-keys"); }

  async listDomains(): Promise<ResendDomain[]> {
    const result = await this.request<ResendList<ResendDomain>>("/domains");
    return result.data || [];
  }

  async assertFreeCapacity(domainName: string, webhookEndpoint: string, managedDomainCount: number): Promise<void> {
    const [domains, webhooks] = await Promise.all([this.listDomains(), this.listWebhooks()]);
    if (!Number.isInteger(managedDomainCount) || managedDomainCount < 1 || managedDomainCount > 2) {
      throw new ProviderError("This Resend account is limited to two domains managed by Mail Center. No resources were created.", "resend", 409, false);
    }
    if (!domains.some(item => item.name.toLowerCase() === domainName.toLowerCase()) && domains.length >= 3) {
      throw new ProviderError("Resend Free domain capacity is exhausted (3 domains per account, including domains outside Mail Center). No resources were created.", "resend", 429, false);
    }
    const otherWebhook = webhooks.find(item => item.endpoint !== webhookEndpoint);
    if (otherWebhook) {
      throw new ProviderError("Resend Free permits one webhook endpoint per account, and a different endpoint is already configured. Mail Center will not replace or delete it.", "resend", 409, false);
    }
  }

  async listWebhooks(): Promise<ResendWebhook[]> {
    const response = await this.request<ResendList<ResendWebhook>>("/webhooks");
    return response.data || [];
  }

  async ensureDomain(name: string, region = "eu-west-1"): Promise<{ domain: ResendDomain; created: boolean }> {
    const domains = await this.listDomains();
    const existing = domains.find(item => item.name.toLowerCase() === name.toLowerCase());
    if (existing) return { domain: existing, created: false };
    const result = await this.request<ResendItem<ResendDomain>>("/domains", {
      method: "POST", body: JSON.stringify({ name, region })
    });
    return { domain: result.data, created: true };
  }

  async ensureWebhook(endpoint: string, events: string[], existingSigningSecret?: string): Promise<{ webhook: ResendWebhook; created: boolean; signingSecret: string }> {
    const existing = (await this.listWebhooks()).find(item => item.endpoint === endpoint);
    if (existing) {
      // The webhook may have been created by an earlier attempt before its
      // response could be persisted. Retrieve the existing secret without
      // deleting the webhook or silently rotating its signing key.
      const details = existing.signing_secret || existingSigningSecret
        ? existing
        : await this.request<ResendWebhook>("/webhooks/" + encodeURIComponent(existing.id));
      const signingSecret = existing.signing_secret || existingSigningSecret || details.signing_secret;
      if (!signingSecret) throw new ProviderError("A webhook already exists for this endpoint, but its signing secret is not retrievable. Supply the secret from the installation vault or retrieve it from the Resend dashboard before retrying.", "resend", 409, false);
      return { webhook: existing, created: false, signingSecret };
    }
    // Resend REST API returns a flat webhook object, not { data: webhook }.
    // Preserve compatibility with mocked/legacy wrapped responses.
    const response = await this.request<ResendWebhook | ResendItem<ResendWebhook>>("/webhooks", {
      method: "POST", body: JSON.stringify({ endpoint, events })
    });
    const webhook = "data" in response ? response.data : response;
    const signingSecret = webhook?.signing_secret;
    if (!webhook?.id || !signingSecret) throw new ProviderError("Resend created the webhook but returned an incomplete response. Retrieve its signing secret from the Resend dashboard before continuing.", "resend", 502, false);
    return { webhook: { ...webhook, endpoint, events }, created: true, signingSecret };
  }
}
