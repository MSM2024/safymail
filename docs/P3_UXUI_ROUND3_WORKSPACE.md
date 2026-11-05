# MSM MAIL — P3 UX/UI round 3: inbox, reader, composer

**Date:** 2026-11-05. **Scope:** styles in `public/msm-mail-ui.css`; existing route `public/index.html`; no new routes and no API changes.

## Changes
- Cohesive workspace tokens for borders, ink, navy, cyan and muted labels. Sidebar, account/folder selection, navigation and status follow one design language.
- Inbox header, search, scrollable quick filters, unread/selected rows, timestamps and actionable controls refined to improve scanability.
- Reader header, metadata, action buttons, attachments, security details and empty state revised for consistent information hierarchy.
- Composer header, inputs, body, attachment affordances and action footer aligned with the main workspace; 16px mobile inputs and short-window adjustments.
- Accessible visible focus states and reduced-motion behavior preserved.

## Regression and certification
`scripts/p3-workspace-premium.test.mjs` protects DOM IDs, styles, existing composer helper selectors, mobile reader back navigation and scrollable compose form. The user's previously reported passing functional tests are accepted as **operator-reported** evidence; automated CI in this PR covers the new style contracts. This change is not a visual E2E certification on mobile browsers.

Manual visual acceptance matrix for any future deployed build: 320x568, 390x844, 768x1024, 1440x900, short 900x560 and mobile keyboard visible. Confirm inbox filtering/scroll, opening and closing message, attachment list overflow, reply/forward and composer save/send controls, quick-filter overflow and no horizontal clipping. Only run real mail E2E when authorized; no production sends were made by this PR.

## Next
Continue P3 with global UI design consistency on contacts, security/admin dialogs and accessibility, followed by screenshot comparison and deployment review.
