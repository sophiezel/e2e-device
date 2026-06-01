#!/usr/bin/env bash
# Shared helpers for e2e-device shell scripts (run from host repo)
set -euo pipefail

e2e_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd
}

_lib_dir() {
  cd "$(dirname "${BASH_SOURCE[0]}")" && pwd
}

skill_root() {
  echo "${E2E_DEVICE_SKILL_ROOT:-${HOME}/.agents/skills/e2e-device}"
}

# Host repo binaries (wdio / appium only)
resolve_host_bin() {
  local name="$1"
  local root="${2:-$(repo_root)}"
  local local_bin="${root}/node_modules/.bin/${name}"
  if [[ -x "$local_bin" ]]; then
    echo "$local_bin"
    return 0
  fi
  return 1
}

ensure_skill_runtime() {
  bash "$(skill_root)/scripts/ensure-skill-runtime.sh"
}

ensure_host_deps() {
  local mode="${1:-wdio}"
  bash "$(_lib_dir)/../ensure-host-deps.sh" "$mode"
}

orch_cli() {
  local root skill ts_node
  root="$(repo_root)"
  skill="$(skill_root)"
  cd "$root"
  ensure_skill_runtime
  export TS_NODE_PROJECT="${TS_NODE_PROJECT:-$root/e2e-device/tsconfig.json}"

  ts_node="${skill}/node_modules/.bin/ts-node"
  if [[ ! -x "$ts_node" ]]; then
    echo "[e2e-device] Skill 编排运行时缺少 ts-node: ${skill}" >&2
    echo "  执行: cd \"${skill}\" && npm install" >&2
    exit 1
  fi
  "$ts_node" e2e-device/orchestration/cli.ts "$@"
}

run_wdio() {
  local root wdio_bin
  root="$(repo_root)"
  cd "$root"
  ensure_host_deps wdio
  if ! wdio_bin="$(resolve_host_bin wdio "$root")"; then
    echo "[e2e-device] 宿主仓库缺少 wdio（真机跑测依赖，见 reference/host-setup.md）" >&2
    exit 1
  fi
  "$wdio_bin" run e2e-device/wdio.conf.ts "$@"
}
