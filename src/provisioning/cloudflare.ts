export interface CloudflareConfig {
  accountId: string;
  apiToken: string;
  fetcher?: typeof fetch;
}
export interface CloudflareD1Database { uuid: string; name: string; version?: string; }
export interface CloudflareKvNamespace { id: string; title: string; }
type CloudflareEnvelope<T> = { success: boolean; errors?: Array<{ code?: number; message?: string }>; result: T };

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: "cloudflare" | "resend",
    readonly status: number,
    readonly retryable: boolean
  ) { super(message); this.name = "ProviderError"; }
}

export class CloudflareClient {
  private readonly fetcher: typeof fetch;
  constructor(private readonly config: CloudflareConfig) {
    if (!/^[a-f0-9]{32}$/i.test(config.accountId)) throw new Error("Invalid Cloudflare account ID.");
    if (!config.apiToken || config.apiToken.length < 20) throw new Error("Cloudflare API token is missing or invalid.");
    // Cloudflare Workers requires the host fetch function to retain its global receiver.\n    // Referencing fetch as a class property can throw TypeError before an HTTP response.\n    this.fetcher = config.fetcher || ((input, init) => globalThis.fetch(input, init));
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher("https://api.cloudflare.com/client/v4" + path, {
      ...init,
      headers: {
        Authorization: "Bearer " + this.config.apiToken,
        "Content-Type": "application/json",
        ...init.headers
      }
    });
    const payload = await response.json().catch(() => null) as CloudflareEnvelope<T> | null;
    if (!response.ok || !payload?.success) {
      const message = payload?.errors?.map(item => item.message).filter(Boolean).join("; ") || "Cloudflare API request failed.";
      throw new ProviderError(message, "cloudflare", response.status, response.status === 429 || response.status >= 500);
    }
    return payload.result;
  }

  async verifyToken(): Promise<void> {
    await this.request<{ id: string }>("/user/tokens/verify");
  }

  async listD1(): Promise<CloudflareD1Database[]> {
    const items: CloudflareD1Database[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await this.request<CloudflareD1Database[]>("/accounts/" + this.config.accountId + "/d1/database?per_page=100&page=" + page);
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items;
  }

  async listWorkers(): Promise<Array<{ id: string }>> {
    const workers: Array<{ id: string }> = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await this.request<Array<{ id: string }>>("/accounts/" + this.config.accountId + "/workers/scripts?per_page=100&page=" + page);
      workers.push(...batch);
      if (batch.length < 100) break;
    }
    return workers;
  }

  async listKvNamespaces(): Promise<CloudflareKvNamespace[]> {
    const items: CloudflareKvNamespace[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await this.request<CloudflareKvNamespace[]>("/accounts/" + this.config.accountId + "/storage/kv/namespaces?per_page=100&page=" + page);
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items;
  }

  /**
   * Fail-closed preflight for the account-level resource-count limits that this
   * installer can verify through Cloudflare's API. This check must run before
   * the first create call. It does not claim to measure daily operations,
   * storage consumption, request usage, or existing Cron Trigger usage.
   */
  async assertFreeCapacity(d1Name: string, workerName: string, kvTitle: string): Promise<void> {
    const [databases, workers, namespaces] = await Promise.all([
      this.listD1(), this.listWorkers(), this.listKvNamespaces()
    ]);

    if (!databases.some(item => item.name === d1Name) && databases.length >= 10) {
      throw new ProviderError("Cloudflare Free D1 database limit reached (10 per account). No resources were created. Remove an unused database or use another Free account.", "cloudflare", 429, false);
    }
    if (!workers.some(item => item.id === workerName) && workers.length >= 100) {
      throw new ProviderError("Cloudflare Free Workers limit reached (100 per account). No resources were created. Remove an unused Worker or use another Free account.", "cloudflare", 429, false);
    }
    if (!namespaces.some(item => item.title === kvTitle) && namespaces.length >= 1000) {
      throw new ProviderError("Cloudflare Workers KV Free namespace limit reached (1,000 per account). No resources were created. Remove an unused namespace or use another Free account; namespaces above this limit can incur charges.", "cloudflare", 429, false);
    }
  }

  async ensureD1(name: string): Promise<{ database: CloudflareD1Database; created: boolean }> {
    const databases = await this.listD1();
    const existing = databases.find(item => item.name === name);
    if (existing) return { database: existing, created: false };
    const database = await this.request<CloudflareD1Database>("/accounts/" + this.config.accountId + "/d1/database", {
      method: "POST", body: JSON.stringify({ name })
    });
    return { database, created: true };
  }

  async ensureKvNamespace(title: string): Promise<{ namespace: CloudflareKvNamespace; created: boolean }> {
    const namespaces = await this.listKvNamespaces();
    const existing = namespaces.find(item => item.title === title);
    if (existing) return { namespace: existing, created: false };
    const namespace = await this.request<CloudflareKvNamespace>("/accounts/" + this.config.accountId + "/storage/kv/namespaces", {
      method: "POST", body: JSON.stringify({ title })
    });
    return { namespace, created: true };
  }

  async findZone(domain: string): Promise<{ id: string; name: string; status: string } | null> {
    const zones = await this.request<Array<{ id: string; name: string; status: string }>>(
      "/zones?name=" + encodeURIComponent(domain.toLowerCase()) +
      "&account.id=" + encodeURIComponent(this.config.accountId) + "&per_page=50"
    );
    return zones.find(zone => zone.name.toLowerCase() === domain.toLowerCase()) || null;
  }
}
