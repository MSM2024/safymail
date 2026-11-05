# MSM MAIL — P3 keyboard and navigation closeout

**2026-11-05 | Scope:** keyboard accessibility and mobile drawer behavior in the existing webmail page. No backend or service changes.

## Code fixes
- Message rows receive a keyboard focus stop, a readable label, and Enter/Space activation, while star/important buttons retain their own click behaviors.
- Mobile menu exposes the expanded state through `aria-expanded` and updates its accessible name when opened or closed.
- Mobile sidebar closes after both mailbox and folder selection, rather than remaining over the newly selected content.
- Message focus and 44px mobile-menu touch size receive explicit styling.

## QA/acceptance classification
- GitHub CI runs regression assertions for current DOM, keyboard event wiring, mobile drawer state and retained account/security/admin/composer interfaces.
- User confirms previous functional checks. That approval remains separate from this change's new behavioral regression.
- **Actual browser keyboard and visual acceptance remains pending** until a browser/device session exercises the rendered site at 320, 390, 768 and desktop widths, portrait/landscape and small-height viewports. Static tests cannot certify layout measurements or focus announcements.

## Manual keyboard verification (future controlled environment)
- Tab from search to a message row; Enter and Space must open it.
- Star and important actions should work independently without opening the message.
- Mobile menu opens with `aria-expanded=true`, and choosing a folder or mailbox closes the drawer and restores `false`.
- Ensure access, MFA, compose and administrator dialogs remain navigable without mouse input.

Do not mark visual E2E PASS based solely on source checks. No mail sends, deploys, DNS edits or production state changes occurred in this code change.
