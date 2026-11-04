# Mail Center Control Plane

Independent provisioning API. It is not imported by the mail-delivery Worker.

## Responsibilities

- Store installation metadata, durable checkpoints and redacted audit events in a dedicated D1 database.
- Accept provider credentials through the authenticated onboarding API and retain them only in an AES-GCM-256 encrypted provider-account vault. The browser never receives stored credentials; temporary per-job envelopes are separately encrypted, expire after 30 minutes and are purged after provisioning.
- Reuse one provider account across no more than two Mail Center domains. The account bundle is keyed by Cloudflare account ID and its Resend signing secret is stored separately from the API credentials.
- Encrypt generated runtime secrets with AES-GCM-256 using a separate CONTROL_PLANE_VAULT_KEY.
- Provision core D1/KV/Resend resources through the shared provider adapters.

## Local setup

1. Create a dedicated D1 database for the control plane. Never reuse a customer's mail D1.
2. Create a dedicated D1 database named mail-center-control-plane. Copy wrangler.control-plane.template.toml to the local, git-ignored wrangler.control-plane.toml and replace its database ID.
3. Deploy the control-plane Worker once to obtain its stable HTTPS `workers.dev` origin, then set `CONTROL_PLANE_PUBLIC_URL` in the config to that exact origin (scheme and host only, no path). This trusted value is used to register the account-scoped Resend webhook; it is never derived from an incoming request Host header.
4. Apply the control-plane migrations with Wrangler using that config.
5. Create the provisioning queue and its dead-letter queue with `npm run queues:control-plane:create`.
6. Configure secrets:
   - CONTROL_PLANE_ADMIN_TOKEN_HASH: lowercase hex SHA-256 of a random API bearer token (at least 32 random bytes).
   - CONTROL_PLANE_VAULT_KEY: independently generated random secret of at least 32 characters.
7. Generate a random bearer token locally and calculate its lowercase hexadecimal SHA-256 hash. Store only the hash as CONTROL_PLANE_ADMIN_TOKEN_HASH; retain the original token in the trusted operator client.
8. Set the secrets with Wrangler using wrangler secret put CONTROL_PLANE_ADMIN_TOKEN_HASH and wrangler secret put CONTROL_PLANE_VAULT_KEY.
9. Run npx wrangler dev --config wrangler.control-plane.toml.

## API

All /api routes require Authorization: Bearer <token>.

- POST /api/provider-accounts: authorize a shared provider bundle using credentials.cloudflareApiToken, credentials.cloudflareAccountId and credentials.resendApiKey. The response includes a stable webhookEndpoint and a maximum of two managed domains. Reauthorizing an account rotates its encrypted credentials; it is rejected while that account is actively provisioning.
- GET /api/provider-accounts: list provider-account metadata and managed-domain counts; never returns credentials.
- POST /api/installations: create installation metadata. Only domain and administrator email are mandatory; appName and workerName are inferred when omitted. Send an Idempotency-Key header to make retries of the creation request return the same installation.
- GET /api/installations: list installations.
- GET /api/installations/:id: inspect installation and checkpoints.
- POST /api/installations/:id/provider-account: associate a draft installation with an existing providerAccountId. A provider account cannot be associated with more than two installations.
- POST /api/installations/:id/provision: enqueue core resource provisioning. Supply provider credentials in the HTTPS request body for first-time onboarding, or omit them when the installation already references an authorized provider account. The response is HTTP 202 with a job ID; poll GET /api/installations/:id for progress. Tokens are never returned.
- POST /webhooks/resend/:providerAccountId: public Resend ingress. It verifies the Svix signature against the encrypted account-level signing secret, deduplicates event IDs, persists fan-out targets and forwards the original signed event to each ready Worker at https://mail.<domain>/api/webhooks/resend. Downstream Workers retain their existing event processing and idempotency logic.
- GET /api/installations/:id/secrets/RESEND_WEBHOOK_SECRET/status: check whether the encrypted webhook secret exists; never returns the secret.
- GET /api/installations/:id/dns-requirements: returns the domain, verified Cloudflare zone ID and Resend DNS records from the provisioning checkpoint. It does not return credentials or modify DNS; use the read-only `npm run plan:dns` command from the trusted terminal to inspect existing records and identify conflicts.
- GET /api/installations/:id/deployment-config: trusted terminal installer only. While status is `configuring`, returns the installation's resource IDs plus decrypted `RESEND_WEBHOOK_SECRET` and derived `MAINTENANCE_TOKEN` and `RESEND_RELAY_TOKEN`. This endpoint is protected by the control-plane administrator bearer token, disables caching, records an audit event and must never be called from browser code or logged. The trusted `npm run deploy:installation` script consumes it to deploy the mail Worker and set secrets through Wrangler stdin.
- GET /api/installations/:id/runtime-config: for a trusted installer/operator only, returns the per-installation maintenance bearer token and endpoint. Do not call this from browser code, log the response, or commit the token. Install it as the mail Worker secret `MAINTENANCE_TOKEN` with `CONTROL_PLANE_URL`, `CONTROL_PLANE_ADMIN_TOKEN` and `INSTALLATION_ID` set in the trusted terminal, then run `npm run configure:maintenance-secret`. The script pipes the token to Wrangler without printing or saving it.

The provisioning endpoint is asynchronous and uses Cloudflare Queues with at-least-once delivery, a ten-retry policy and a dead-letter queue. The queue message contains only the installation ID and job ID. Long-lived provider credentials are encrypted with AES-GCM-256 in the dedicated control-plane D1 database and bound to the provider-account identity as authenticated additional data. Temporary job envelopes are separately encrypted, bound to the installation/job identity and expire after 30 minutes. A five-minute Cron trigger removes expired envelopes and marks abandoned jobs failed. The queue consumer uses a 10-minute installation lease plus a separate 10-minute account-scoped lease keyed by Cloudflare account ID, fenced checkpoints and idempotent provider reconciliation. This serializes installs managed by this control plane so they cannot simultaneously pass the same D1/Worker/KV count preflight and over-allocate those resources. A retryable provider failure is retried; permanent failures are marked failed and the encrypted envelope is deleted. If a job exhausts queue retries, its envelope remains encrypted only until expiry and is then purged. The same single Cron trigger dispatches maintenance every 15 minutes in batches of up to ten ready installations, avoiding a Cron per mail Worker and keeping Queue operations bounded on Free accounts.

## Free-plan operation

The target deployment is Cloudflare Workers Free plus Resend Free. Review [FREE_TIER_COMPATIBILITY.md](../docs/FREE_TIER_COMPATIBILITY.md) before provisioning. The mail Worker template has no Cron trigger; one control-plane Cron handles credential cleanup and dispatches maintenance every 15 minutes through the existing Queue, in batches of up to ten installations. Each mail Worker exposes a bearer-authenticated internal maintenance endpoint, protected by a unique HMAC-derived token. Fetch its runtime config only from a trusted installer and set `MAINTENANCE_TOKEN` with Wrangler. Resend Free allows one webhook endpoint per account. Mail Center now registers one account-scoped control-plane endpoint and fans verified events out to a maximum of two ready installations. It will not replace an unrelated existing webhook endpoint. Outbound email now uses an installation-authenticated relay and a D1 send ledger shared by every installation linked to the same provider account. The relay reserves the 100/day and 3,000/month UTC Free-tier limits atomically and enforces idempotency across installations. External applications using the same Resend account cannot be included in Mail Center's usage counter; use a dedicated account for the tool. Do not enable pay-as-you-go or paid-plan features.

## Important limitations

- Deploy this service separately from every mail Worker.
- Use a dedicated control-plane account/database and tightly scoped provider tokens. The Cloudflare token currently needs Account D1 Read/Edit, Account Workers KV Storage Read/Edit and Zone Zone Read for the selected account. The preflight lists D1 databases, Workers scripts and KV namespaces before the first create request; ensure the token can read all three lists. The Resend key needs domain and webhook management permissions.
- Resend DNS records have a read-only planner and a separately confirmed apply command that creates only missing, non-conflicting records; it never updates or deletes existing DNS. Cloudflare Email Routing has a read-only DNS/settings/catch-all planner. Its DNS records must still be reviewed and applied separately; after Email Routing reports `ready`, a separately confirmed CLI can create the Worker catch-all only when no incompatible route exists. Custom-domain routing is available as a separate read-only preflight (`npm run plan:custom-domain`) and an explicitly confirmed apply (`npm run setup:custom-domain -- --apply`). The default hostname is `mail.<domain>`. The command refuses to attach when any DNS record already exists at that hostname or when another Worker domain is attached; Cloudflare then creates the DNS record and TLS certificate. Automatic administrator bootstrap is still pending. The trusted terminal deployment script applies mail D1 migrations, deploys the Worker and installs runtime secrets, but the installation remains in configuring until DNS, custom-domain routing, Email Routing, bootstrap and end-to-end verification are complete. Runtime maintenance-token issuance is available to the trusted installer, but must be installed as a Worker secret before that Worker can receive scheduler calls.
- Provider error details and credentials are deliberately excluded from persistent logs.
- The shared webhook signing secret is encrypted at rest with AES-GCM-256 and authenticated against the provider-account/secret identity. A separately encrypted copy is issued to each Worker as a runtime secret so that the original Resend signature can be verified again at the destination. The signing secret is never exposed through the API.
- The generated Worker name receives a short unique suffix when inferred, avoiding collisions between installations of the same domain.


## Custom Domain routing

- The default web hostname is `mail.<domain>`; it is attached to the installation Worker using Cloudflare Workers Custom Domains.
- Run `npm run plan:custom-domain` first. This is read-only and checks the Worker, existing Worker-domain attachments and all DNS records in the zone.
- Only when the hostname is unclaimed and has no DNS records, run `npm run setup:custom-domain -- --apply` from an interactive trusted terminal and type the exact hostname.
- The apply command repeats the checks immediately before the write. It never deletes or edits existing DNS or detaches another Worker domain. It also refuses any existing exact or wildcard Worker route that overlaps the hostname, because Worker routes take precedence over Custom Domains. If the preflight is incomplete or finds a conflict, it fails closed.
- Required Cloudflare permissions include Workers Scripts Read/Write, Workers Routes Read and Zone DNS Read. The custom-domain API attaches the Worker hostname and Cloudflare provisions the DNS record and TLS certificate.
- Email Routing catch-all remains a separate operation. Its planner and apply command do not alter Custom Domain configuration. The apply command first inspects the dedicated catch-all endpoint; if Cloudflare reports that no catch-all object exists, it lists all zone rules and creates an `all` matcher through `POST /email/routing/rules` only when no conflicting all-recipient rule exists. It updates only an existing disabled default-drop rule, never an enabled route to another destination. The planner and apply command paginate rule listings and fail closed if inspection is incomplete.
