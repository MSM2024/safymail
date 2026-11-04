# MSM MAIL · SMTP/Resend outbound readiness

Status: **design / verification pending**. No live send enabled by this document.

## Observed architecture

- Webmail sends via `POST /api/messages/send` on the installation Worker.
- The installation Worker requires `CONTROL_PLANE_URL`, `INSTALLATION_ID` and `RESEND_RELAY_TOKEN` to send. This token must remain a Worker secret.
- The control plane exposes `POST /internal/installations/:id/resend/send` and relays authenticated mail through `https://api.resend.com/emails`.
- `RESEND_API_KEY` is used by installation administration to manage/verify sending domains; the relay credential for outgoing mail is controlled centrally.
- Webmail attaches a stable `idempotency_key`; the backend records an outgoing message and status. Do not bypass this contract with a direct browser-to-Resend call.
- At present, a standalone SMTP submission server is **not** implemented or certified. Calling the existing HTTP relay “SMTP enabled” would be inaccurate.

## Proposed deployment order

1. **Sender identity:** verify ownership of each sending domain and the actual DNS records shown by Resend (SPF/DKIM and DMARC), without replacing the current inbound routing or MX records.
2. **Secrets:** install Resend API credentials and installation-specific relay authentication through Cloudflare secret management; never put credentials in frontend JS, the repository, screenshots or logs.
3. **Provider transport:** retain Resend REST via control plane as the first verified outbound path; enforce From-domain authorization, account permissions, input validation and attachment policy.
4. **SMTP track (optional distinct feature):** define whether MSM MAIL should expose an SMTP submission endpoint to clients (ports 587/465, TLS, authenticated user, per-account policy) or merely use an SMTP provider upstream. Design and certify this separately; do not claim support based only on provider REST integration.
5. **Acceptance tests:** domain sending-ready state; authorized single recipient and To/CC/BCC; invalid sender rejection; retryable provider failure; idempotent retries; scheduled/queued status; attachment MIME and sizes; bounce/complaint delivery updates; account isolation; no duplicate sends; logs without PII/secrets.
6. **Safe rollout:** use one verified sender and a controlled test recipient; capture provider message IDs and audit events; then expand account by account. Preserve 97 historical messages, 5 attachments, and D1/KV objects.

## Release gates

```powershell
npm run typecheck
npm test
npm run validate:pwa
npm run validate:security
```

Run integration tests against a staging installation with valid Cloudflare/Resend secrets; the unit tests above **cannot** certify live SMTP or provider delivery. Production deployment requires an explicit go/no-go based on observed provider responses and DNS health.
