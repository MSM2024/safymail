export interface WorkerDomainState {
  hostname?: string;
  service?: string;
  enabled?: boolean;
  zone_id?: string;
}
export type WorkerDomainDecision = "already_configured" | "create" | "conflict";

export function assessWorkerDomain(
  current: WorkerDomainState | null,
  hostname: string,
  workerName: string,
  zoneId: string
): WorkerDomainDecision {
  const normalizedHost = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalizedHost)) {
    throw new Error("Invalid custom-domain hostname.");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(workerName)) {
    throw new Error("Invalid Worker name.");
  }
  if (!/^[a-f0-9]{32}$/i.test(zoneId)) throw new Error("Invalid Cloudflare zone ID.");
  if (!current) return "create";
  const currentHost = String(current.hostname || "").toLowerCase().replace(/\.$/, "");
  if (currentHost !== normalizedHost) return "create";
  if (current.service === workerName && current.zone_id?.toLowerCase() === zoneId.toLowerCase() && current.enabled === true) {
    return "already_configured";
  }
  return "conflict";
}

export function hasDnsConflictForCustomDomain(
  hostname: string,
  records: Array<{ type?: string; name?: string }>
): boolean {
  const normalizedHost = hostname.trim().toLowerCase().replace(/\.$/, "");
  return records.some(record =>
    String(record.name || "").trim().toLowerCase().replace(/\.$/, "") === normalizedHost
  );
}

export function hasWorkerRouteConflict(
  hostname: string,
  routes: Array<{ pattern?: string }>
): boolean {
  const normalizedHost = hostname.trim().toLowerCase().replace(/\.$/, "");
  return routes.some(route => {
    const pattern = String(route.pattern || "").trim().toLowerCase();
    const match = pattern.match(/^(\*\.)?([a-z0-9.-]+)(?::\d+)?(?:\/.*)?$/);
    if (!match) return true;
    const routeHost = match[2].replace(/\.$/, "");
    if (match[1] === "*.") {
      return normalizedHost.endsWith("." + routeHost) && normalizedHost !== routeHost;
    }
    return routeHost === normalizedHost;
  });
}
