# ADR-0004: Adaptive Session Policy (段界 + 按需 reload)

## Status

Accepted (2026-07-29)

## Context

Periodic `reloadSession` every N cases was added to mitigate UiAutomator2 / WebView resource leaks. In practice it:

- Conflicts with No-Reset / warm Session design (PHILOSOPHY 决策 8)
- Costs 30–90s wall clock per reload under the 25min `standard` budget
- Often fails to re-enter H5 after reload (`journeyEntryPrepared` / `before` hook not re-run)

## Decision

**C 自适应段界派**:

1. `quick` / `standard`: **no periodic** mid-segment `reloadSession`
2. Form cases beyond `E2E_STANDARD_FORM_CAP` split into Journey sub-segments (`form`, `form_2`, …) — session refresh at segment boundaries
3. **Adaptive** one-off reload when: 2× expertReset timeout, WebView contexts > 2, segment slowdown 2×, or post heal
4. Adaptive reload **must** call `ensurePilotEntry({ force: true })` after `prepareDeviceSession`
5. `resilience` retains periodic reload for stress coverage
6. Escape hatch: `E2E_ALLOW_MID_SEGMENT_RELOAD=1`

## Consequences

- Fewer false flakes from stale NATIVE context after reload
- Better wall-clock fit for `standard` profile
- Long single form chunks without split may still need adaptive reload on weak devices
- `session-adaptive.ts` tracks per-segment signals; `wdio.conf.sandbox.ts` implements policy
