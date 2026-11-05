# MSM MAIL — P0 security engineering closeout and P1 entry

Date: 2026-11-05. Repository: `MSM2024/safymail`.

## P0 engineering status: CLOSED (source + CI), with deployment acceptance outstanding

P0 code corrections were merged into main with successful GitHub CI:
- #20: MFA recovery code redemption associated with the active challenge.
- #21: `send_only` cannot read or change shared drafts.
- #22: MFA login identity reports the actual database superadmin role.
- #23: verified MFA for administrator password changes and fail-closed enrolled TOTP.
- #24: atomic failed-login counters and lockout thresholds.
- #25: view active sessions and revoke other devices, password/MFA gated.
- #26: tenant/permission checks inside message and contact writes.
- #27: tenant/permission checks inside draft update/delete writes.

**This is an engineering closeout, not a production penetration-test certificate.** GitHub CI, static contracts and unit tests do not substitute for runtime authorization tests.

## Remaining P0 production acceptance gates

- [ ] Two independent test companies and two different mailbox users: assert 403/404 for cross-company account IDs, message IDs, attachments, draft IDs, sending and contact mutations.
- [ ] Verify `read_only`, `read_write` and `send_only` authorization against live Worker API (including after permission revocation).
- [ ] Verify MFA enrollment, codes, recovery, administrator gating, invalid/missing TOTP, and session revocation from a separate browser.
- [ ] Verify brute-force lockout and throttle reset with disposable test accounts, with safeguards against locking out the real administrator.
- [ ] Review Cloudflare rate-limiting/WAF and logs before production security sign-off.
- [ ] Confirm deployment version and complete read-only smoke tests after each mail Worker release.

No production data migration, credential rotation or Cloudflare configuration change is implied by this document.

## P1 functional work

- #28: Spam/Trash logical separation preserving historical Mailu junk; using `user_marked_spam` marker instead of unsupported `folder='spam'` value.
- Next: end-to-end reply/reply-all/forward verification; draft lifecycle and cross-device consistency; attachment round-trip; message threading and search/pagination; contact flows; responsive/mobile UX; accessibility and performance; backup and restore QA.
- Each feature requires automated regressions and a Worker smoke test before P1 certification.

## Release rules

1. CI typecheck + tests PASS.
2. No unreviewed D1 migrations or changed production bindings.
3. Deploy mail Worker with `wrangler.toml` only after pulling `main`.
4. Verify incoming and outgoing mail smoke tests after deployment.
5. Record exact deployed Worker version and runtime results separately from source-level CI.
