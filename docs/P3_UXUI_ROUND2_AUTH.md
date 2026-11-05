# MSM MAIL — P3 UX/UI round 2: premium authentication

Date: 2026-11-05. Scope: existing auth overlay in `public/index.html` and `public/msm-mail-ui.css`.

## Implemented
- Unified visual treatment for superadmin bootstrap, normal password login, and TOTP/recovery-code challenge, preserving all three existing API routes and form field identifiers.
- Refined background, brand identity, contrast, touch target sizes, field spacing and primary button hierarchy.
- Accessible live error feedback (`role=alert` + `aria-live=polite`) and OTP input with no browser spellcheck or automatic capitalization.
- Responsive behavior at 320px/390px widths and short-height mobile viewports; content can scroll instead of being clipped. Keyboard focus and reduced-motion preferences remain explicit.

## Certification boundary
CI checks static application contracts and regression tests only. Design has **not** been visually verified on real devices, nor has authenticated E2E been executed in this round. A login-specific design screenshot or user-provided reference may inform the following refinement; no new OAuth or email OTP was introduced because existing login is password + TOTP/recovery and those are distinct security flows.

## Next UX/UI work
- Visual inspection of bootstrap/login/MFA on 320px, 390px, 768px, and desktop, including a height of 560px and on-screen keyboards.
- Inbox/reader and compose design consistency; continue on existing routes and keep backend and Resend unchanged.
