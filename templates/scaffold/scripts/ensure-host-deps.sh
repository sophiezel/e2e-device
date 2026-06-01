#!/usr/bin/env bash
# Ensure host repo has wdio/appium devDependencies (orchestration uses skill runtime).
set -euo pipefail

MODE="${1:-wdio}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

AUTO_INSTALL="${E2E_AUTO_INSTALL_DEPS:-1}"

WDIO_PKGS=(
  @wdio/cli@^8.40.0
  @wdio/local-runner@^8.40.0
  @wdio/mocha-framework@^8.40.0
  @wdio/spec-reporter@^8.40.0
  @wdio/appium-service@^8.40.0
  @wdio/globals@^8.40.0
  appium@^3.4.2
)

detect_pm() {
  if [[ -f yarn.lock ]] && command -v yarn >/dev/null 2>&1; then
    echo yarn
    return
  fi
  if command -v npm >/dev/null 2>&1; then
    echo npm
    return
  fi
  if command -v yarn >/dev/null 2>&1; then
    echo yarn
    return
  fi
  echo ""
}

has_bin() {
  local name="$1"
  [[ -x "${ROOT}/node_modules/.bin/${name}" ]]
}

missing_wdio() {
  ! has_bin wdio || ! has_bin appium
}

print_install_guide() {
  local pm="$1"
  shift
  local pkgs=("$@")
  echo "" >&2
  echo "[e2e-device] 当前宿主仓库缺少真机跑测依赖，请在项目根目录执行：" >&2
  if [[ "$pm" == yarn ]]; then
    echo "  yarn add -D ${pkgs[*]}" >&2
  else
    echo "  npm install --save-dev ${pkgs[*]}" >&2
  fi
  echo "" >&2
  echo "编排（discover/probe/plan）使用 Skill 自带运行时，无需在宿主安装 ts-node。" >&2
  echo "详见：reference/host-setup.md（Skill 目录）" >&2
  echo "禁用自动安装：export E2E_AUTO_INSTALL_DEPS=0" >&2
}

run_install() {
  local pm="$1"
  shift
  local pkgs=("$@")
  echo "[ensure-host-deps] installing via ${pm}: ${pkgs[*]}"
  if [[ "$pm" == yarn ]]; then
    yarn add -D "${pkgs[@]}"
  else
    npm install --save-dev "${pkgs[@]}"
  fi
}

ensure_wdio() {
  if ! missing_wdio; then
    return 0
  fi

  local pm
  pm="$(detect_pm)"
  if [[ -z "$pm" ]]; then
    print_install_guide npm "${WDIO_PKGS[@]}"
    return 1
  fi

  if [[ "$AUTO_INSTALL" != "1" ]]; then
    print_install_guide "$pm" "${WDIO_PKGS[@]}"
    return 1
  fi

  if ! run_install "$pm" "${WDIO_PKGS[@]}"; then
    echo "[ensure-host-deps] 自动安装失败" >&2
    print_install_guide "$pm" "${WDIO_PKGS[@]}"
    return 1
  fi

  if missing_wdio; then
    echo "[ensure-host-deps] 安装后仍缺少 wdio 或 appium" >&2
    print_install_guide "$pm" "${WDIO_PKGS[@]}"
    return 1
  fi
  return 0
}

case "$MODE" in
  wdio|all)
    ensure_wdio
    ;;
  orch)
    echo "[ensure-host-deps] orch 已迁至 Skill 运行时，无需在宿主安装 ts-node" >&2
    echo "  若缺失: bash \"\$(skill_root)/scripts/ensure-skill-runtime.sh\"" >&2
    exit 0
    ;;
  *)
    echo "[ensure-host-deps] unknown mode: $MODE (wdio|all)" >&2
    exit 1
    ;;
esac
