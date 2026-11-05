# MSM MAIL — P2 Free-first Observability and Release Assurance

> **Cierre administrativo 2026-11-05:** Implementación técnica P2 cerrada para habilitar la ronda UX/UI. Certificación operativa total expresamente diferida; las métricas externas continúan UNKNOWN y el gate global permanece BLOCKED. Acta y traspaso: [P2_ADMINISTRATIVE_CLOSEOUT_AND_P3_UI_HANDOFF.md](./P2_ADMINISTRATIVE_CLOSEOUT_AND_P3_UI_HANDOFF.md).



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

## P2-02 account quota reconciliation — operator procedure

**Status: local D1 ledger observations supported; account-wide usage is UNKNOWN until independently observed.**

- Read-only command without provider figures: `powershell -NoProfile -File scripts/msm-resend-readonly-audit.ps1`. This counts `reserved/sent/uncertain` by shared provider account for UTC day/month and never asserts external usage.
- When Resend dashboard provides both account-wide UTC day and current-month counts, record their observation time in UTC and run `powershell -NoProfile -File scripts/msm-resend-readonly-audit.ps1 -ProviderDaily 8 -ProviderMonthly 25 -ProviderObservedAtUtc "2026-11-05T18:25:00Z"` (numbers **illustrative only**).
- Timestamp must be fresh (at most 15 minutes), current UTC day, explicit `Z`; values must be nonnegative integers and supplied together. Stale or partial observations fail closed. Do not treat Resend dashboard figures with ambiguous/non-UTC windows as certified.
- Dashboard gap = provider counter minus D1 reservation ledger count; gap can be negative because reserved/uncertain records count defensively. **A positive gap is not independently proof of external sends** and absence of a gap does not prove none occurred.
- Conservative observed use = maximum of dashboard count and D1 reservation count in each period. Warning levels: watch 50%, warning 80%, critical 95%, exhausted 100% of 100/day or 3000/month. Unknown provider usage never reports account-wide remaining capacity.
- Current D1 figures and provider dashboard observations can change; do not treat past output as current quota, guaranteed sending capacity, or real-time platform enforcement. No automated emails, billing changes, provider API credentials or production writes are involved.

## P2-03 webhook lineage and dedup — operator evidence

**Status: read-only lineage checks implemented; live database results pending.** Run `powershell -NoProfile -File scripts/msm-resend-readonly-audit.ps1` after syncing `main`; do not send synthetic email to generate events.

- `control_webhook_deliveries` joined to `control_webhook_events` on both provider account and event key. Report only aggregated orphan delivery rows, unexpected statuses, retried pending rows, pending rows whose last attempt is older than one hour, forwarded rows without delivery timestamp, and distinct forwarded provider events.
- The duplicate audit groups stored event keys by provider account and event key and counts duplicate groups, without exposing either key or message content. A zero count **does not measure repeated HTTP webhook submissions** which the existing `SELECT` plus `INSERT OR IGNORE` path may suppress before persistence.
- Current forwarding code accepts already seen events and retries pending deliveries; its data model records the final forwarding state, not every upstream HTTP retry. A `delivered` delivery means **forwarded to the target Worker** and must not be presented as provider-confirmed delivery to a mailbox.
- The first real run determines whether event-to-delivery lineage is clean. Database read failures or missing fields are `UNKNOWN`, not a passing inspection. No secrets, event IDs, raw webhook JSON or recipients are printed.

## P2-03 actual read-only D1 audit — 2026-11-05T19:07Z

Operator reported domain `msmmystore.com` active/verified and Control Plane ready/active. Webhook counts: **0 pending**, **4 forwarded to Worker**, **0 retries**, maximum 1 attempt; lineage: **4 delivery rows**, **4 distinct forwarded events**, **0 orphan rows**, **0 unexpected states**, **0 stale pending**, **0 forwarded without timestamp**, and **0 duplicated stored event keys**. Thus P2-03 read-only **stored-event lineage PASS for this sample**. The data does not establish recipient delivery, observe all HTTP retry attempts, or validate future traffic. Resend local ledger: 3/day and 3/month (provider-account totals UNKNOWN).

## P2-04 scheduler and queue — read-only evidence

At 2026-11-05T19:07Z, the operator reported **66 dispatch rows** in 24h, last dispatched slot `2026-11-05T19:00:00.000Z`, mail Worker last completed slot `2026-11-05T19:00:00.000Z`, and no active maintenance lock. This is positive completion evidence for the most recent slot only. Older slots are not individually certified by this aggregate.

The audit adds a separate read-only count of distinct scheduled slots in the prior 24 hours and age in minutes of the latest dispatch, with an alert if older than 30 minutes. Queue **pending messages, retries, DLQ depth and consumer execution histories** are explicitly UNKNOWN from D1 dispatch claims. Inspect `msm-mail-provisioning` and `msm-mail-provisioning-dlq` metrics in Cloudflare before declaring P2-04 fully certified. Do not generate test messages, replay, delete or drain queues during read-only certification.

## P2-04 supplemental operator evidence — 2026-11-05T19:11:17Z

The second read-only audit reports **66 dispatch rows / 66 distinct slots in 24h**, **64 historical dispatches older than 30 minutes** (ordinary historical rows, NOT failures), latest dispatch `2026-11-05T19:00:00.000Z`, latest completed slot `2026-11-05T19:00:00.000Z`, no active maintenance lock, and latest dispatch age **11.5 minutes**. No observed duplicate slots in that interval. The data does not establish that scheduling operated for all preceding 24 hours or certify every historical completion.

Added pure read-only latest-slot comparator `scripts/p2-maintenance-completion.mjs`: an observed healthy latest slot requires matching dispatch/completion slots, a recent timestamp (at most 30 minutes) and valid D1 lock state. Any mismatch, stale record, or unavailable data is flagged as alert/unknown; the report never equates a dispatch claim with queue execution. Cloudflare Queue pending counts, retry counts and DLQ depth remain external evidence.

## P2-05 / P2-06 / P2-07 — closure controls and read-only runbook

**No global P2 GO is claimed from CI or D1-only evidence.** The local `docs/P2_EVIDENCE_TEMPLATE.json` is intentionally all `PENDING`. Copy it to a private, gitignored operator path outside this repository and fill only aggregate evidence with a UTC observation time. Never commit credentials, emails, user names or raw provider identifiers. `node scripts/p2-closure-gate.mjs <private-file.json>` returns `BLOCKED` until all six external checks are freshly attested; the gate is an **operator evidence validation**, not an independent provider query.

### P2-04 Cloudflare Queues and DLQ

In the Cloudflare account dashboard, inspect Queues `msm-mail-provisioning` and `msm-mail-provisioning-dlq` for current queued/backlogged messages, consumer errors, retries and available throughput/age charts. Record each metric's exact name, observed value, units, UTC timestamp and whether it is unavailable, without recording message bodies. Queue messages can be consumed between snapshots, so a momentary depth of zero alone cannot certify retry handling. Mark P2-04 `PASS` only with meaningful coverage and no unexplained backlog, error spike or DLQ accumulation. D1 most recent dispatch/completion agreement is useful but NOT a substitute for Queues provider metrics.

### P2-05 Cloudflare Free budgets

Inspect the provider account plan and exact current limits before interpreting percentages, since provider allowances can change. Capture UTC current-day and monthly usage **with their real windows** for Worker requests, CPU time, D1 reads/writes/database storage, KV operations/storage, Queue operations/backlog and any billed features actually enabled. For each metric record whether the provider dashboard exposes a current value, source dashboard page and observation time. Use thresholds 50% watch, 80% warning, 95% critical, and 100% stop-and-investigate (for each confirmed cap). An unknown cap/usage must stay `UNKNOWN`, never green; do not enable billing automatically.

### P2-06 P1 manual evidence ledger

Review `docs/P1_PRODUCTION_ACCEPTANCE.md` and produce a private anonymized ledger for P1-08 through P1-14 containing: check identifier, tested feature, expected/observed behavior, tester role/device category, UTC timestamp and sanitized evidence reference. Separate CI assertions from actual operator test observations; don't fabricate device runs. Record failures as `PENDING` until corrected/rechecked; avoid message bodies, attachments, email addresses or auth credentials.

### P2-07 safe release / rollback checklist

Before any future promotion: verify `git status` is clean, intended Git commit, `npm test` / typecheck / build CI gates, current `npm run qa:p2:release:verify`, public health and active Worker Version ID with `npm run qa:p2:worker:active -- 94a7ed90-9478-4cc6-b339-97d6ca23d2b4` (replace with actual expected ID when changed). Verify bindings and existing `wrangler.toml` **locally** because these files may not be tracked in Git; don't print secret values. Record both Worker ID and release-manifest fingerprint before promotion.

A real rollback is a privileged production change: document intended known-good Worker Version ID and use Cloudflare's deployment controls only with a separate explicit approval and verified backup; **do not execute rollback as part of read-only P2 certification**. After any authorized rollback, repeat health, route, inbound/outbound user validation under approved test quota, and active Worker Version ID checks. Prove rollback capability through a reviewable non-destructive procedure or an approved isolated rehearsal; mere documentation does not certify an executed rollback.

### P2 closure gates

`p2-01-bundle`: verifiable Worker bundle digest or equivalent build-to-deployment attestation (beyond published manifest + current Version ID). `p2-02-provider`: current Resend **account-wide** daily/monthly usage independently observed and reconciled with local reservations. `p2-04-queues`: provider Queue and DLQ metrics inspected. `p2-05-cloudflare`: Cloudflare Free plan limits and usage windows captured. `p2-06-manual`: anonymized manual P1 acceptance evidence completed. `p2-07-rollback`: approved non-destructive rollback readiness review completed.

To avoid mixing partial and full assurance, the global P2 gate returns **BLOCKED** when any control is absent, stale (older than 24 hours), unverified, unknown, or missing a safe evidence description. This does not block ongoing mail operations; it blocks claiming final P2 certification.

## P2-06 / P2-07 executable safeguards — 2026-11-05

- `docs/P2_P1_MANUAL_EVIDENCE_TEMPLATE.json` deliberately starts with P1-08..P1-14 `PENDING`. Copy to a private local file outside Git. Each result records device/role category, expected and observed behavior, UTC timestamp and redacted evidence reference. `npm run qa:p2:p1:manual -- <absolute-private-file.json>` returns PASS only for all seven **instrumented** real observations. Historical operator-reported P1 acceptance stays accepted functionally but **does not become instrumented** simply by copying a statement into a template.
- `npm run qa:p2:release:preflight -- 94a7ed90-9478-4cc6-b339-97d6ca23d2b4` is a *read-only* metadata preflight. It verifies a clean tracked worktree, published release-manifest consistency and authenticated active Cloudflare Worker version (100% traffic) through existing scripts. It neither deploys nor rolls back. Output `PASS-METADATA-ONLY` explicitly does **not** certify a running bundle digest, production E2E or a successful rollback rehearsal. The expected ID is an observation from 2026-11-05; replace it whenever an authorized deployment changes.
- The global P2 evidence gate remains separately **BLOCKED** until provider account usage, Cloudflare Queues/DLQ, resource budgets, human test ledger, bundle attestation and rollback readiness are independently verified. Do not mark an unknown field as PASS.

## P2-04 and P2-05 — structured Cloudflare provider evidence

New files: `docs/P2_CLOUDFLARE_METRICS_TEMPLATE.json` and `scripts/p2-cloudflare-metrics.mjs`. Keep the completed file **outside Git** in a private location and run:

```powershell
npm run qa:p2:cloudflare:metrics -- "C:\\private\\p2-cloudflare-metrics.json"
```

Collect the dashboard observations for primary queue backlog/retries/consumer errors, DLQ backlog, Worker requests/CPU, D1 reads/writes/storage, KV operations/storage and Queue operations. Match each reading to its **actual provider time window and unit**, current UTC observation timestamp, dashboard source, and the **confirmed** plan-specific limit where one exists. Do not fabricate limits. Unavailable observations remain `unavailable`. Record only aggregates, never raw queue messages, email recipients or payloads.

The validator rejects stale observations (over one hour), future timestamps, missing metrics, unknown budget limits and recorded queue anomalies. Budget thresholds are watch 50%, warning 80%, critical 95% and exhausted 100% **only when provider account caps have been verified**. Queue backlog/error/retry/DLQ metrics are checked for nonzero values separately; they are not treated as quota percentages. Even `METRICS-OBSERVED` certifies a timestamped observation set, **not** a live Queue execution history, successful retry handling, a tested rollback, the current provider plan or overall P2 GO.

**Current status:** provider-specific evidence is still `UNKNOWN`. The earlier operator audit establishes latest D1 scheduler slot completion only. Do not convert its 67 dispatches into Cloudflare queue consumption numbers.

## Hard safety conditions

- A successful CI suite is not an authenticated production E2E certificate.
- Resend Free limit enforcement is currently **100/day, 3000/month**, per provider account, based on local ledger; external sends to same Resend account are not tracked by that ledger.
- Do not expose `CONTROL_PLANE_ADMIN_TOKEN`, `RESEND_RELAY_TOKEN`, `CONTROL_PLANE_VAULT_KEY` or webhook secrets. Never use bootstrap token as administrator API token.
- On any uncertainty in quota, relay idempotency, maintenance or webhook outcomes, fail closed and preserve real mail delivery.
