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

# Resolve binary path with priority: env var > project > skill > global
# Usage: resolve_bin <name> [repo_root]
resolve_bin() {
  local name="$1"
  local root="${2:-$(repo_root)}"
  local skill="$(skill_root)"
  
  # Priority 0: Environment variable override
  # Use eval for bash 3.2 compatibility (macOS default) instead of ${!env_var}
  local env_var="E2E_$(echo "$name" | tr '[:lower:]' '[:upper:]')_BIN"
  local env_val=""
  eval "env_val=\${${env_var}:-}"
  if [[ -n "$env_val" && -x "$env_val" ]]; then
    echo "$env_val"
    return 0
  fi
  
  # Priority 1: Project local
  local project_bin="${root}/node_modules/.bin/${name}"
  if [[ -x "$project_bin" ]]; then
    echo "$project_bin"
    return 0
  fi
  
  # Priority 2: Skill directory
  local skill_bin="${skill}/node_modules/.bin/${name}"
  if [[ -x "$skill_bin" ]]; then
    echo "$skill_bin"
    return 0
  fi
  
  # Priority 3: Global (only for wdio/appium)
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return 0
  fi
  
  return 1
}

# Legacy function for backward compatibility
resolve_host_bin() {
  resolve_bin "$@"
}

ensure_skill_runtime() {
  bash "$(skill_root)/scripts/ensure-skill-runtime.sh"
}

ensure_host_deps() {
  local mode="${1:-wdio}"
  echo "[e2e-device] wdio/appium 已迁移至 Skill 级，ensure-host-deps 已废弃" >&2
  echo "  运行: cd \"$(skill_root)\" && npm install" >&2
  return 0
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
  
  # Resolve wdio with priority
  if ! wdio_bin="$(resolve_bin wdio "$root")"; then
    echo "[e2e-device] wdio 未安装" >&2
    echo "  选项 1: cd \"$(skill_root)\" && npm install（推荐，Skill 级）" >&2
    echo "  选项 2: cd \"$root\" && yarn add -D @wdio/cli@^8.40.0 ...（项目级覆盖）" >&2
    exit 1
  fi
  
  # Log which wdio is being used
  local skill_root_path="$(skill_root)"
  if [[ "$wdio_bin" == *"${skill_root_path}"* ]]; then
    echo "[e2e-device] using wdio from Skill: $wdio_bin" >&2
  else
    echo "[e2e-device] using wdio from project: $wdio_bin" >&2
  fi
  
  "$wdio_bin" run e2e-device/wdio.conf.ts "$@"
}
