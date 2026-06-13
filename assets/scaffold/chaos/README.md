# Chaos cases

Chaos specs are **generated targets** from `discover-chaos` (union with matrix/diff).

- Registry: `chaos/chaos-case-registry.json`
- Run via full suite: `bash scripts/run.sh --project .`
- Plan only: `bash scripts/run.sh --project . --plan-only`

Do not hand-edit registry during normal flows; re-run discover after route changes.
