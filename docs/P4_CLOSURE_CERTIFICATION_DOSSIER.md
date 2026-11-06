# MSM MAIL — P4 final certification dossier

Date: 2026-11-05. Scope: release `msm-mail-preview`, custom domain `mailme.msmmystore.com`.

## Verified in this review
- Operator supplied an actual P4 public smoke result: **PASS-READ-ONLY** across 14 public/anonymous controls, including `/admin` HTTP 200, `/admin.html` 307 canonical hop to `/admin`, branding, health, UI assets, and six private API endpoints denying anonymous reads.
- GitHub pull requests #79–#83 were merged to MSM `main` after CI success. This supports source integration, not proof that the newest static assets are loaded in an existing open tab.
- The connected, read-only browser tab at `https://mailme.msmmystore.com/admin` displayed a populated superadmin session and management overview (companies, domains, mailboxes, users). It still contained Unicode navigation labels typical of the previous UI version. A previously opened tab may be stale and cannot establish a live deployment regression without a fresh reload/asset inspection.
- External public HTTP fetch was unavailable from this runtime. No credentials were read; the browser connector can read but not click, submit MFA, send email, navigate forms, or inspect privileged network sessions in this conversation.

## P4 closure requirements (11)

| ID | Mandatory actual verification | Evidence class |
| --- | --- | --- |
| p4-public | 14-point public smoke PASS | instrumented run |
| p4-release | Published manifest matches referenced Git revision and latest Worker version has 100% traffic | instrumented run |
| p4-login | Real login and logout; session unusable after logout | witnessed / instrumented |
| p4-mfa | TOTP challenge works; unauthorized admin attempt rejected | witnessed / instrumented |
| p4-isolation | Different tenant/role cannot access another account | witnessed / instrumented |
| p4-inbox | Authenticated received message and inbox/reader/pagination | witnessed / instrumented |
| p4-compose | Draft/reply/forward/attachments and idempotent sending | witnessed / instrumented |
| p4-delivery | Real approved Resend send + inbound webhook receipt in mailbox | witnessed / instrumented |
| p4-contacts | Authorized create/search/update/delete of an isolated test contact | witnessed / instrumented |
| p4-admin | Real navigation and guarded admin operations | witnessed / instrumented |
| p4-mobile | 320/390/768/1440 responsive, keyboard/focus and main actions | witnessed / instrumented |

An actual `PASS` record must have `observedAtUtc` within 48 hours, `operatorVerified: true`, `evidenceMode` equal to `instrumented` or `witnessed`, a non-sensitive reference starting `run:`, `test:`, `capture:`, `ticket:` or `audit:` and a concise non-sensitive observation. `operator-reported` alone cannot pass. This gate validates **declared evidence structure**, not screenshots' authenticity. Never store passwords, tokens, OTP, mailbox addresses, customer messages or session cookies.

### Local-only ledger example

Create a **private local file outside version control** with schema:

```json
{
  "schema": "msm-mail-p4-functional-v1",
  "controls": [
    {
      "id": "p4-public",
      "result": "PASS",
      "observedAtUtc": "2026-11-05T23:00:00Z",
      "evidenceMode": "instrumented",
      "operatorVerified": true,
      "evidenceRef": "run:public-smoke-20261105",
      "observed": "All fourteen anonymous public and guard checks passed."
    }
  ]
}
```

The example is **illustrative and incomplete**; update timestamps from real runs, supply remaining IDs from the table only after executing them and preserve evidence privately.

```powershell
npm run qa:p4:public:smoke
npm run qa:p2:release:verify
npx wrangler deployments list --config wrangler.toml
npm run qa:p4:closure -- C:\\private\\msm-p4-evidence.json
```

**P4 is not closed until the gate returns GO with real evidence and authenticated E2E confirmed.** This stage never grants authorization to create privileged users, change security roles, send customer mail, or mutate production data merely to satisfy a check. Use approved test accounts/mailboxes, controlled message content and review the external provider quota.

## Visual discrepancy to resolve
Open admin tab currently displayed legacy Unicode menu glyphs while GitHub source contains `data-msm-icon` SVG slots. After refresh, verify the document and `/msm-mail-ui.js` were published together; inspect actual network content in the authorized browser rather than assuming the tab is current. The public smoke checks MIME/availability, not asset fingerprints. If mismatch persists, inspect release provenance and Cloudflare asset caching before changing UI source.
