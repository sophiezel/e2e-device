#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source "$(dirname "$0")/lib/common.sh"
orch_cli probe-env --adb-only
