import type { Env } from "../types";

/**
 * Read-only transport preflight. Never returns tokens, private URLs or credentials.
 * Does not make network requests and does not assert provider acceptance.
 */
export interface OutboundPreflight {
  ready: boolean;
  transport: "resend_relay";
  reason: "ready_for_attempt" | "relay_not_configured" | "relay_url_invalid";
}

export function getOutboundPreflight(env: Pick<Env, "CONTROL_PLANE_URL" | "INSTALLATION_ID" | "RESEND_RELAY_TOKEN">): OutboundPreflight {
  if (!env.CONTROL_PLANE_URL || !env.INSTALLATION_ID || !env.RESEND_RELAY_TOKEN) {
    return { ready: false, transport: "resend_relay", reason: "relay_not_configured" };
  }
  try {
    const endpoint = new URL(env.CONTROL_PLANE_URL);
    const isLocal = ["localhost", "127.0.0.1"].includes(endpoint.hostname);
    if ((endpoint.protocol !== "https:" && !(isLocal && endpoint.protocol === "http:")) ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      return { ready: false, transport: "resend_relay", reason: "relay_url_invalid" };
    }
  } catch {
    return { ready: false, transport: "resend_relay", reason: "relay_url_invalid" };
  }
  return { ready: true, transport: "resend_relay", reason: "ready_for_attempt" };
}
