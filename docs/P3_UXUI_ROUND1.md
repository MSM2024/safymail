# MSM MAIL — P3 UX/UI foundation, round 1

**Date:** 2026-11-05. **Target:** existing `public/index.html` webmail; **no alternate route**, no backend change.

## Inspected sources
- `public/index.html`: inline layout styles, auth shell, folder list, message list and reader, composer/security dialogs.
- `public/msm-mail-ui.css`: responsive shell and safe-area/composer overrides.
- `public/msm-composer-r3.css`: autocomplete/attachment widgets.

## Confirmed CSS defects and changes
- Mobile reader back navigation was rendered by the JS but an inherited global `.mobile-back{display:none}` rule could hide it. The final stylesheet now explicitly displays it only when a message is open at mobile width, preserving the list-only view otherwise.
- Fixed-height app workspace with `min-height:490px` in the previous override could clip short desktop windows. The P3 override permits a true dynamic viewport height with no mandatory minimum while preserving internal scroll containers.
- Auth overlay previously used a center-placed grid and could be clipped on low-height displays. It now scrolls, fits the current viewport and respects safe-area insets.
- Login inputs use 16px text on mobile to avoid focus zoom in common mobile browsers; focus visibility and reduced-motion preferences remain explicit.
- Existing message read/write endpoints, provider bindings, domains, mailbox and composer behavior are unchanged.

## Validation boundary
The new CI regression tests assert the actual HTML references and CSS/JS contracts. **This is not visual E2E evidence.** Follow with 320, 390, 768 and desktop widths, short-height 560px and landscape; inspect splash/login, reader back button, mailbox scroll, composer and security dialog. No production deploy was performed.

## P3 next rounds
1. Screen-by-screen login/OTP/splash UX tokens and iconography.
2. Workspace inbox/list/reader density, spacing, empty/loading/permission/error states.
3. Composer and attachments: mobile keyboard, short-height, feedback and keyboard shortcuts.
4. Admin/settings accessibility and desktop constraints.
5. Visual device matrix, screenshots and release gate.
