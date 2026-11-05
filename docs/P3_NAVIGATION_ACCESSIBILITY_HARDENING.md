# MSM MAIL · P3 post-design accessibility hardening

Date: 2026-11-05. Scope: current mail/admin interfaces, without changing mail, authentication, data or deployment configuration.

## Findings and corrections
- Admin and folder navigation previously conveyed the active state only using CSS `active`; keyboard/screen-reader users were not given a consistent current location. Added `aria-current="page"` initialization and updates on menu changes.
- Very narrow mobile widths render install/logout controls visually as icons without text. Added explicit Spanish `aria-label` and title attributes, retaining the underlying visible label for larger widths.
- Mailbox status feedback receives a polite live region, while message list gets a descriptive accessible label.
- Active folder and keyboard focus styling reinforces the shared SVG UI design.

## QA
Regression checks are integrated into `npm test`. Source and CI certification is separate from live device/browser checks. Live URL inspection from the current tool session did not return page content, so no screenshot, 320px device, authenticated mailbox or deployment status is claimed as verified.

## Release
Merge to `main` after green CI. For the next Worker release, follow `docs/P3_WORKER_DEPLOY_RUNBOOK.md`, check the approved `msm` remote, run the preflight and dry-run, and deploy only the existing `msm-mail-preview` with correct D1/KV/service bindings. This change itself does not deploy.
