# MSM MAIL — P3 reliability refinement: stale search results and keyboard drawer

Date: 2026-11-05. Scope: existing public/index.html mail UI, no backend or provider mutations.

## Verified source defects
1. Search, filter, folder and mailbox actions can issue overlapping `/api/messages` calls. Before this patch, slower older requests could replace a newer result set, causing messages from the wrong query or mailbox to appear.
2. Pagination requests could append an old page after a filter or account change, and could leave the new query's load-more button disabled.
3. The mobile drawer exposed its ARIA state but did not have a direct Escape-key close path restoring the menu trigger's focus.

## Corrective changes
- Monotonic `listRequestEpoch` invalidates stale list and pagination responses, including stale errors, on each new list load.
- New loads restore the pagination button availability; old pagination `finally` blocks cannot interfere with a newer request.
- Escape dismisses an open drawer, sets `aria-expanded=false`, restores the label and focuses the menu trigger.
- Existing endpoints, compose, authentication and message operation logic remain unchanged.

## Verification boundary
- CI covers static source-contract regressions and all existing test suites.
- Browser-based race simulation (delayed network responses), actual visual viewport QA, and authenticated production E2E remain unobserved in this round. These should not be called certified merely because source tests pass.
- No deployment, DNS, D1, Queue, secret or email send operations were executed.
