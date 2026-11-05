# MSM MAIL — P4 functional acceptance round 1

Date: 2026-11-05. Release source: `MSM2024/safymail`. Target Worker: `msm-mail-preview`; public hostname: `https://mailme.msmmystore.com`.

## Source-code finding

The `/api/branding` GET route is documented as a public hostname-scoped product identity for the login UI. Two existing generic `/api/*` middleware layers had excluded health, webhook and auth, but **not branding**: anonymous clients encountered session enforcement before loading their theme/brand. Both guards now explicitly bypass authentication and tenant session checks for this **read-only** endpoint. It returns only product/company names from active host assignments; no credentials, account lists or message contents.

## Safe functional probe

After the approved build and Worker deployment, run from the authenticated local development checkout (does not send credentials or require a session):

```powershell
npm run qa:p4:public:smoke
if ($LASTEXITCODE -ne 0) { throw "P4 public smoke failed" }
```

The fixed-host read-only checker GETs the login UI shell, admin shell, UI JavaScript and CSS, health JSON and branding JSON; then asserts that anonymous reads of `/api/me`, `/api/accounts`, `/api/messages`, `/api/contacts`, `/api/notifications`, and `/api/admin/companies` are denied with 401 or 403. Redirects and unexpected MIME types fail closed. It never POSTs, sends mail, fetches personal message data under a user session, logs tokens, changes database state or alters Cloudflare. A network failure is not a pass.

## P4 certification matrix

| Area | Automated guarantee | Live follow-up |
| --- | --- | --- |
| Branding/Login | Public branding route and anonymous JSON contract | Brand name, logo and responsive layout in a real browser |
| Inbox/Reader | Source tests cover read permissions and list race isolation | Authenticate as user and open/read a message; no cross-tenant leakage |
| Compose | Existing tests cover attachments, drafts, reply, threading and idempotency | Approved test mailbox end-to-end send and receive, provider receipt and quotas |
| Contacts | Session isolation and storage permission tests; anonymous route denied | Create/search/delete authorized sample contact |
| Admin | Auth/MFA guard tests and anonymous admin denial | Authorize admin session; confirm roles, domains and hostnames |
| Security | Existing MFA/TOTP, session, CSRF and scope tests | Validate real MFA and logout/revocation on supported devices |
| UX and PWA | P3 structural/accessibility checks; assets smoke | Manual device widths 320, 390, 768, 1440 and offline recovery |

## Status boundaries

Source/CI evidence does **not** certify external delivery, Cloudflare queues, Resend success, an authenticated user journey, a specific Worker version, device rendering, or P2 operational signoff. The public smoke command must be run only after deploying this change. The scripts are non-mutating and cannot substitute for release-provenance, version audit or genuine E2E sessions.

## Deployment gate

Merge after green CI; update local `main` from the approved `msm` remote while retaining upstream template `origin`. Run `npm test`, `npm run typecheck`, `npm run qa:p3:deploy:preflight` and Wrangler `--dry-run --keep-vars`. Review the actual D1, KV and control-plane service bindings before deploying the existing `msm-mail-preview` only. Then run P4 smoke. This change does not perform any remote deployment.
