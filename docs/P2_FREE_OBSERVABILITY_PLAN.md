# MSM MAIL — P2 Free-first Observability and Release Assurance

**Start:** 2026-11-05
**Baseline:** P1 accepted functionally, PR #49 merged (`ab474948f40972b922edcfceec89a074b9300065`).
**Environment:** `mailme.msmmystore.com` / Worker `msm-mail-preview`, Cloudflare Workers Free + D1 + KV + Resend Free.
**Delivery policy:** No DNS mutations, mail sends, migration applies, secret rotation, deployment or cache purges during read-only discovery. No live test emails merely to prove observability.

## Priorities and evidence gates

| ID | Objective | Read-only evidence and safe mechanism | Acceptance |
|---|---|---|---|
| P2-01 | Verifiable Git SHA ↔ Worker version mapping | Introduce build provenance only in a reviewed deployment flow; record release Git SHA, Wrangler Worker version ID and asset fingerprint together. Do not equate `Source: Unknown` with a known commit. | Machine-verifiable metadata from deployed Worker and matching release artifact, plus CI PASS |
| P2-02 | Resend quota budget across provider account | Compare Control Plane shared reservation ledger `reserved/sent/uncertain` against Resend provider account usage. Existing read-only PowerShell audit reports **local** reservations only. | Daily/monthly figures + UTC timestamps + explicit external usage delta; alerts before hard limits |
| P2-03 | Webhook traceability and dedup | Read `control_webhook_events`, `control_webhook_deliveries` and safe aggregate statuses; no message content, tokens or identifiers in public logs. | Actual event lineage, duplicate handling, delivered/failed status reconciled without sending test mail |
| P2-04 | Scheduler/Queue and D1 lock health | Read job states, DLQ counts and `mail_maintenance_lock.last_completed_slot` through authenticated, read-only admin/audit tooling. | Evidence of last successful slot, failures, queue backlog and idempotent repetition |
| P2-05 | Operational Cloudflare Free budgets | Inspect Workers requests, D1 reads/writes/storage, KV usage, Queue operations and CPU p95 from provider dashboards. | Thresholds documented, no automatic billing enablement or speculative free headroom |
| P2-06 | P1 manual evidence ledger | Record anonymized operator attestations (test type, expected/observed state, timestamp, role/device) without message content or credentials. | Reproducible summary for P1-08..14, distinct from CI tests |
| P2-07 | Release safety | Document rollback route and preflight gates with correct Wrangler configuration and no secret exposure. | Release checklist, controlled staged promotion and rollback drill without affecting active mail |

## Existing verified baseline

- D1 production-oriented remote checks for both databases: `No migrations to apply!`; this does not prove every table is intact.
- `/api/health`: `ok` in `preview`, public HTML `current`, correct canonical redirects, private endpoint anonymous request 401.
- Cloudflare Email Routing catch-all active → `msm-mail-preview`; domain inbound/outbound verified by D1; provider Resend reported `Verified`.
- Operator reports successful delivery and reception, MFA, draft, concurrency, permissions, Spam/Trash and responsive tests.
- Shared Resend ledger observation at last audit: **3/100 daily** and **3/3000 monthly** (UTC), not total Resend account usage and not a live guarantee of remaining quota.
- Engineering Gate PASS and 133 automated tests + 9 public-probe tests on preceding P1 branch.

## Safe execution order

1. P2-02 / P2-04: add read-only summarized counters and explicit unknown states to the existing PowerShell audit, with automated regression tests.
2. P2-03: inspect real webhook delivery history through D1 read-only, protect privacy and avoid fabricated events.
3. P2-01: prepare build/deploy provenance contract and a deterministic deployment checklist; execute deployment only with reviewed target and approval.
4. P2-05 / P2-06 / P2-07: assess provider dashboards, evidence ledger, release/rollback gates.

## P2-01 release evidence — 2026-11-05

**Result: published manifest and Git-tree consistency PASS, runtime attestation pending.**

- Deployment executed by operator to existing `msm-mail-preview`: Version ID `94a7ed90-9478-4cc6-b339-97d6ca23d2b4` (Cloudflare Wrangler CLI output, 2026-11-05T17:37Z). This version was recorded at publication time; the manifest alone cannot cryptographically prove the running Worker bundle.
- `msm-release.json` published via custom domain and direct Workers.dev host; both canonical and controlled-query probes return HTTP 200, JSON `release-manifest`, and commit `6d1e513e065fb89e3aa2583832ae4774444416ff`. Diagnosis `both-serve-same-manifest`.
- After PR #55 (`79b3d62e26d101d62799510021a777e48f1316cc`) the operator ran `npm run qa:p2:release:verify`: `manifest-match-windows-checkout`, status 200, localHead `79b3d62...`, publishedCommit `6d1e513...`. Indicates published SHA-256 of source and HTML matches the referenced Git blobs once their Windows checkout newline representation is taken into account; source and HTML comparisons PASS.
- No assertion that `main` HEAD is deployed; the published release is intentionally an older commit. No new live sends or DNS changes were part of this verification.
- On 2026-11-05 operator executed `npm run qa:p2:worker:active -- 94a7ed90-9478-4cc6-b339-97d6ca23d2b4` using an existing authenticated Wrangler session: `expected-version-at-100-percent`, latest deployment created `2026-11-05T17:37:15.766Z`, active Worker version `94a7ed90-9478-4cc6-b339-97d6ca23d2b4` at **100%**. This confirms the active deployment metadata and reconciles it with the manually recorded release, without any extra API token or mail send.
- The audit emitted Node `DEP0190` because it launched `npx.cmd` with `shell:true` on Windows. The follow-up correction invokes the installed Wrangler JavaScript entrypoint using the running Node executable with `shell:false`; CI regression checks that no shell is invoked.
- **Remaining for strict P2-01 GO:** bind the recorded Worker Version ID to a machine-verifiable build/deployment attestation, including worker bundle digest, then test the verified runtime release. Status is **PARTIAL PASS**, not full cryptographic proof.

## Hard safety conditions

- A successful CI suite is not an authenticated production E2E certificate.
- Resend Free limit enforcement is currently **100/day, 3000/month**, per provider account, based on local ledger; external sends to same Resend account are not tracked by that ledger.
- Do not expose `CONTROL_PLANE_ADMIN_TOKEN`, `RESEND_RELAY_TOKEN`, `CONTROL_PLANE_VAULT_KEY` or webhook secrets. Never use bootstrap token as administrator API token.
- On any uncertainty in quota, relay idempotency, maintenance or webhook outcomes, fail closed and preserve real mail delivery.
