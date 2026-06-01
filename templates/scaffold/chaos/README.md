# Chaos cases

Chaos specs are **generated targets** from `discover-chaos` (union with matrix/diff).

- Registry: `chaos/chaos-case-registry.json`
- Run via full suite: `bash e2e-device/scripts/init.sh`
- Plan only: `bash e2e-device/scripts/init.sh --plan-only`

Do not hand-edit registry during normal flows; re-run discover after route changes.
