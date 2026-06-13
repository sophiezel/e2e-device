#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source "$(dirname "$0")/lib/common.sh"
if [[ -p /dev/stdin ]] || [[ ! -t 0 ]]; then
  orch_cli save-local-config "$(cat)"
else
  orch_cli save-local-config "${1:-{}}"
fi
