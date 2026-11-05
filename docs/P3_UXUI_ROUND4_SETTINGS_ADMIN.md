# MSM MAIL — P3 round 4: contacts, security and administration

**Scope:** existing `public/index.html`, `public/msm-mail-ui.css`, `public/admin.html`. No new routes, no backend/auth changes.

## Corrections
- Contact list now uses semantic reusable CSS classes rather than inline row dimensions and has wrapped addresses, mobile touch targets, accessible delete labels and live status.
- Contacts and account-security dialogs are contained within viewport and scroll internally on short displays, including safe-area support. MFA backup/secret content wraps without exposing it in logs.
- Administration keeps all existing tabs but enables horizontal tab scrolling on mobile, usable forms and a keyboard-focusable horizontally scrollable data table. Navigation, form actions and visible focus are responsive.
- The admin notice now exposes its operational status through an accessible live region.

## Evidence boundaries
The user indicated preceding functional tests are certified. This update adds source-contract regressions to CI. Real visual interaction at 320, 390, 768 and desktop viewports remains to be checked after a separately approved deployment; these source tests alone do not attest screenshot quality or live mail behavior. No emails sent or production changes.

## Future P3 verification
Check contact create/delete feedback, invalid addresses, empty lists, TOTP enrollment, password update, administrative table scroll and keyboard focus with test accounts and no secret recording. Protect API and roles across any following changes.
