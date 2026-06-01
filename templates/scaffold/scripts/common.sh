#!/usr/bin/env bash
# Shared helpers for e2e-device shell scripts
set -euo pipefail

e2e_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd
}

orch_cli() {
  local root
  root="$(repo_root)"
  cd "$root"
  yarn -s ts-node e2e-device/orchestration/cli.ts "$@"
}
