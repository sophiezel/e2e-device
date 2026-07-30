# Dogfood Appendix — 2026-07-29

> Non-blocking appendix. Skill merge DoD = contract tests + self-check-offline.
> This document records the dogfood procedure and prior-run observations for traceability.

## Prior run (trigger for selector-contract fix)

A real-device quick run on an integrated host project produced 0/5 pass rate.
The run validated Wave1 orchestration (journey segments, budget enforcement) while
exposing Skill-layer defects:

| Observation | Root cause | Fix |
|-------------|-----------|-----|
| `invalid selector: Unsupported CSS selector` | Generator emitted comma-separated `$()` | P0: selector tiers SSOT + `waitForH5Selector`/`queryDisplayedH5` |
| case-cache hit but specs missing | Cache gate only checked version | P0: registry↔spec audit before cache hit |
| `domain_fixtures_missing` | Host did not provide `e2e-device/fixtures/<domain>/` | P1: fixture template + improved blocker message (host responsibility) |
| preclassify → `L2_biz` for selector errors | Classifier too broad | P1: `L1_spec_invalid` layer added |
| auto-heal JSON parse failure | `|| echo '{}'` appended invalid JSON | P2: preflight `--json` exits 0, stderr to log |

## Post-fix verification runbook

Execute on **any** integrated host project (host provides triplet + fixtures):

1. Clear old case-cache for the project hash:
   ```bash
   rm -rf ~/.e2e-device/projects/<hash>/case-cache/
   ```

2. Confirm triplet via list-preconfig:
   ```bash
   bash ~/.agents/skills/e2e-device/scripts/list-preconfig.sh --project <host-root>
   ```

3. Host provides `e2e-device/fixtures/<domain>/` (copy from `assets/scaffold/fixtures/_template/`).

4. Quick run — verify no `invalid selector`:
   ```bash
   bash ~/.agents/skills/e2e-device/scripts/run.sh --project <host-root> --mode quick --plan-only
   ```

5. Standard run — verify form segment + adaptive session:
   ```bash
   bash ~/.agents/skills/e2e-device/scripts/run.sh --project <host-root> --mode standard
   ```

6. (Optional) Flake check — same config 3x:
   ```bash
   for i in 1 2 3; do
     bash ~/.agents/skills/e2e-device/scripts/run.sh --project <host-root> --mode quick
   done
   ```

## Pass criteria

- No `invalid selector` / `Unsupported CSS selector` errors in generated specs
- `preclassify` labels selector-syntax failures as `L1_spec_invalid` (not `L2_biz`)
- case-cache audit triggers regen when specs are missing
- auto-heal preflight JSON parses without `|| echo '{}'` fallback
- Business pass rate depends on host fixture completeness (not a Skill gate)

## Status

- [x] Contract tests green (7/7, incl. hash deeplink + route graph fixture)
- [x] self-check-offline green (5/5)
- [x] validate-skill-dry-run: 1 known pre-existing exception (`present-test-plan.ts` process.exitCode)
- [ ] 真机端到端：依赖宿主 triplet + 登录/代理；见各宿主 `list-preconfig` 输出
