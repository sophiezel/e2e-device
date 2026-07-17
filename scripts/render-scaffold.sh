#!/usr/bin/env bash
# LEGACY / DEAD — do not use.
# v2 sandbox is prepared by scripts/run.sh under $E2E_HOME/sandbox/{hash}/{domain}/.
# Writing scaffold into the host project violates zero-project-writes.
#
# Canonical entry: bash scripts/run.sh --project <path>
set -euo pipefail
echo "ERROR: render-scaffold.sh is LEGACY and disabled." >&2
echo "Use: bash ~/.agents/skills/e2e-device/scripts/run.sh --project <path>" >&2
exit 2
