/**
 * Mail worker override is installation-scoped and cannot route to another
 * organization's domain. A service binding is only used for an exact domain
 * match; other tenant deliveries keep their original default route.
 */
export function resolveMailWebhookRoute(
  domain: string,
  boundDomain?: string,
  boundHost?: string
): {url:string; useBinding:boolean} {
  const validHost = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  if (!validHost.test(domain)) throw new Error("invalid_installation_domain");
  const overrideMatch = domain === boundDomain &&
    typeof boundHost === "string" &&
    validHost.test(boundHost) &&
    boundHost.endsWith("." + domain);
  return {
    url: "https://" + (overrideMatch ? boundHost : "mail." + domain) + "/api/webhooks/resend",
    useBinding: Boolean(overrideMatch)
  };
}
