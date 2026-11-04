# Installer implementation

The installer is being delivered in phases. The control plane provisions the dedicated D1/KV and Resend resources asynchronously. A separate trusted terminal step now generates the local Wrangler configuration, applies mail migrations, deploys the Worker and installs runtime secrets.

## Trusted Worker deployment

Run this only from a trusted operator terminal with the template repository checked out. Do not run it from browser JavaScript, a public web page, or an untrusted CI runner.

Required environment variables:

- `CONTROL_PLANE_URL`: HTTPS base URL of the deployed control plane.
- `CONTROL_PLANE_ADMIN_TOKEN`: trusted control-plane bearer token.
- `INSTALLATION_ID`: installation ID returned by the control plane.
- `CLOUDFLARE_API_TOKEN`: Cloudflare token authorized to deploy Workers and apply D1 migrations in the target account.
- `RESEND_API_KEY`: dedicated Resend Free account API key for this installation.
- `TOTP_ENCRYPTION_KEY`: persistent 32-byte base64url key. Generate once with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` and store it in a secure password manager. Reuse the same value on every redeployment; losing it makes existing TOTP secrets unreadable.

After the control-plane job reaches `configuring`, run:

```bash
npm run deploy:installation
```

The script retrieves a deployment manifest over HTTPS from the authenticated control plane, writes a mode-0600 local `installation.json`, generates the ignored Wrangler config, applies the dedicated D1 migrations remotely, deploys the Worker, then installs `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `MAINTENANCE_TOKEN`, the per-installation `RESEND_RELAY_TOKEN`, `TOTP_ENCRYPTION_KEY` and a generated `BOOTSTRAP_TOKEN` using Wrangler stdin. Secret values are not written to config files or printed, except the one-time bootstrap token which is displayed so the trusted operator can create the initial administrator. The control-plane endpoint decrypts and returns only the webhook secret and derives the maintenance and Resend relay tokens for this authenticated operator action. Outbound email and scheduled retries use the central relay; domain-management API calls still use the runtime Resend key.

The script is idempotent for resource creation and migrations, but rerunning rotates the bootstrap token. Do not run it after bootstrap has already been completed unless you intend to rotate that token. Always reuse the same TOTP encryption key.

## Safety properties

- The deployment manifest endpoint is protected by the control-plane administrator bearer token and only works while the installation is in `configuring`.
- The script requires HTTPS, validates the installation ID and resource identifiers, and refuses incomplete manifests.
- Provider credentials are not passed to the browser. Cloudflare and Resend credentials are supplied to the trusted terminal environment.
- Local installation and Wrangler files are git-ignored and written with restrictive permissions.
- Wrangler receives secret values through stdin; the script never places them in command-line arguments.
- The original Europe Mail Center Preview and Production resource IDs are rejected by the configuration generator.
- The script does not configure DNS, Email Routing, custom-domain routes, or mark the installation ready.
- Never enable Cloudflare paid features or Resend pay-as-you-go as part of this workflow.

## Read-only DNS preflight

The Resend domain's required DNS records are stored in the provisioning checkpoint. The authenticated `GET /api/installations/:id/dns-requirements` endpoint exposes only the domain, Cloudflare zone ID and provider-required records. Run `npm run plan:dns` from the trusted terminal with `CONTROL_PLANE_URL`, `CONTROL_PLANE_ADMIN_TOKEN`, `INSTALLATION_ID` and a Cloudflare API token with DNS Read permission.

The planner reads all DNS records in the zone (up to 2,000; it fails closed if pagination is incomplete) and classifies each Resend record as already present, missing or requiring manual reconciliation. The read-only command never changes DNS. The separate `npm run apply:dns -- --apply` command re-runs the preflight, refuses any conflict, displays the exact missing records and requires typing the full domain name before it creates them. It only sends DNS record creation requests; it never updates or deletes an existing record. Existing SPF, DKIM, DMARC, MX and CNAME records are preserved. This is an outbound Resend DNS setup only, not Email Routing configuration.

For inbound Email Routing, run `npm run plan:email-routing` with a Cloudflare read-only token scoped to Zone Settings Read and Email Routing Rules Read. It inspects the Email Routing service state, Cloudflare's required inbound DNS records and the current catch-all action. It never enables the service, creates DNS records or changes routing rules. An existing enabled catch-all pointing somewhere else is treated as a conflict, never replaced automatically. After DNS records are safely applied and Cloudflare reports Email Routing as enabled with status `ready`, `npm run setup:email-routing -- --apply` can create the Worker catch-all route. It requires Email Routing Rules Write, Zone Settings Read and Workers Scripts Read, then asks the operator to type the full domain. It accepts only a missing catch-all or the disabled default drop rule; it never overwrites an enabled or non-default route.

## Remaining phases

1. Explicitly enable Cloudflare Email Routing only after its required MX/SPF/DKIM records have been reviewed and safely applied; then verify the Worker catch-all route and service status.
2. Initial administrator bootstrap using the one-time token, followed by immediate token removal.
3. Automated health, DNS, inbound, outbound and webhook verification.
4. A guarded state transition to `ready` only after all checks pass.
5. Full Free-account end-to-end validation.
