# Provisioning engine — provider adapters

This phase adds server-side Cloudflare and Resend adapters and a first idempotent resource provisioning operation.

## Implemented

- Cloudflare API token validation.
- Exact active-zone discovery in the selected Cloudflare account before any resource is created.
- Discovery-before-create for D1 databases and KV namespaces.
- Resend domain discovery-before-create.
- Resend webhook discovery-before-create.
- Stable resource naming derived from the Worker slug.
- Mandatory durable checkpoint callback after each completed provider operation.
- Mandatory secure callback to store the Resend webhook signing secret; it is never included in the returned provisioning result.
- HTTPS webhook endpoint validation constrained to the installation domain/subdomains and the expected webhook path.
- Structured provider errors with retryability metadata.
- The orchestrator returns provider resource IDs and Resend DNS records; it does not write DNS or deploy a Worker.

## Security boundary

These modules are server-side TypeScript. Never import them from browser code or expose provider credentials in an API response. The caller must be a trusted control-plane backend that obtains credentials from secret storage or a short-lived authorization flow. Do not mount these adapters in the mail-delivery Worker.

## Current limitations

- Provider pagination beyond the first 100 resources is not yet implemented.
- A resource with the same deterministic name is reused; production control-plane work must persist its provider/account ownership and verify that it was created for the same installation before reuse.
- DNS changes, Email Routing, Worker upload, secret installation and D1 migration are intentionally not executed in this phase.
- The first preflight requires the installation domain to exist as an active Cloudflare zone in the selected account. External DNS is not supported by this first path.
- Provider operations execute sequentially and each completed step must be persisted through the mandatory checkpoint callback. The control-plane caller is responsible for making that callback durable and retry-safe.
