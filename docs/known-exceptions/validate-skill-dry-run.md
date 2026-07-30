# Known Validation Exceptions

Pre-existing issues that `validate-skill-dry-run.sh` flags but are NOT in scope for the
current fix plan. These are tracked separately to avoid blocking Skill merges.

## present-test-plan.ts — process.exitCode direct assignment

**File**: `assets/scaffold/orchestration/present-test-plan.ts` (lines ~293, ~301)

**Symptom**: `validate-skill-dry-run.sh` reports:
```
FORBIDDEN process.exitCode direct assignment in .../present-test-plan.ts (should only be in cli.ts)
```

**Root cause**: `present-test-plan.ts` sets `process.exitCode = 3` and `process.exitCode = 2`
to signal non-zero exit for plan-only / validation-failure modes. The Skill's structural
validator requires `process.exitCode` to only appear in `cli.ts`.

**Status**: Pre-existing (present in HEAD before the selector-contract fix plan).
Tracked as a separate issue — not introduced by the P0–P3 fixes.

**Workaround**: None needed for offline contract tests. The `self-check-offline.sh`
pipeline (5 checks) passes independently. Only the structural `validate-skill-dry-run.sh`
flags this, and only because of this pre-existing assignment.

**Fix path (future)**: Move the exit-code logic into `cli.ts` as a return value, or
exempt `present-test-plan.ts` in the validator with a documented rationale.
