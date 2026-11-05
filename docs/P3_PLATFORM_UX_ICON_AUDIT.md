# MSM MAIL — P3 platform-wide UX consistency and SVG icon design

Date: 2026-11-05. Scope: existing webmail `/` and admin `/admin`. No new navigation paths, authentication endpoints, database migrations, mail sends, or Worker secrets.

## Reviewed surfaces
| Surface | Finding | Applied improvement |
| --- | --- | --- |
| Global mail navigation | Mixed Unicode symbols and mismatched control density | Shared outlined SVG icon set, mobile menu and toolbar affordances |
| Inbox list | Search field weakly distinguished; selected and flagged rows used typographic symbols | Search icon and input container, coherent selection/hover/focus, dynamic mail/flag SVG |
| Reader | Empty-state decorative letter did not match product icon system | Illustrated SVG mail state, scalable contrast and hierarchy |
| Compose | Primary action and dialog close used different typographic conventions | Action iconography, consistent control height and labels |
| Contacts and security | Dialog close controls inconsistent with compose | Standard close SVG and visible text, no icon-only critical operation |
| Administration | Nine nav sections used Unicode glyphs from unrelated styles | One SVG library, aligned icons and text, improved responsive navigation |
| Administrative forms, KPI cards, tables | Divergent hierarchy and action colors | Unified surfaces, type scale, accessible focus and table navigation |

## Icon contract
- The existing progressive enhancement script (`public/msm-mail-ui.js`) is extended with shared paths and a `data-msm-icon` vocabulary.
- Paths are rendered as inline outlined SVG with `aria-hidden=true`; actionable controls retain their text labels, titles or accessibility names.
- Dynamic message rows are refreshed after DOM changes; mutation processing does not replace already enhanced SVG nodes, preserving event handlers.
- The same stylesheet governs webmail. Admin uses matching scoped CSS and loads the shared enhancement script.
- No external icon CDN, additional package dependency or speculative icon font is introduced.

## Quality boundary
CI now asserts icon keys, compilation of enhancement script, unchanged form IDs, core navigation and contrast/focus selectors. This is **source/engineering acceptance only**, not device-based visual certification. Review at 320/390/768/1440 widths, with keyboard navigation, reduced motion, and actual user/auth sessions after deployment.

## Publication
Merge this change after successful CI. Only deploy the existing `msm-mail-preview` using the approved Wrangler preflight, dry-run and the confirmed binding contract. No Cloudflare deployment is performed by this commit.
