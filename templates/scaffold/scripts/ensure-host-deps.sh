#!/usr/bin/env bash
# Symlink wdio/appium/globals from skill node_modules into host.
# No packages are installed in the host — all deps live in skill.
set -euo pipefail

MODE="${1:-wdio}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SKILL_ROOT="${E2E_DEVICE_SKILL_ROOT:-${HOME}/.agents/skills/e2e-device}"
SKILL_NM="${SKILL_ROOT}/node_modules"
HOST_NM="${ROOT}/node_modules"

PKGS=(
  @wdio/cli @wdio/local-runner @wdio/mocha-framework
  @wdio/spec-reporter @wdio/json-reporter @wdio/appium-service
  @wdio/globals @types/mocha appium
  ts-node typescript
)

is_real_install() {
  # true when host/node_modules/$1 is a real file/dir (not a symlink)
  local target="$HOST_NM/$1"
  [[ -e "$target" && ! -L "$target" ]]
}

ensure_symlink() {
  local pkg="$1"
  local src="$SKILL_NM/$pkg"
  local dst="$HOST_NM/$pkg"

  if [[ ! -e "$src" ]]; then
    echo "[ensure-host-deps] SKIP (missing in skill): $pkg" >&2
    return 0
  fi

  if is_real_install "$pkg"; then
    echo "[ensure-host-deps] SKIP (host-managed): $pkg" >&2
    return 0
  fi

  # Ensure parent directory exists (for @scoped/packages)
  local parent
  parent="$(dirname "$dst")"
  if [[ ! -d "$parent" ]]; then
    mkdir -p "$parent"
  fi

  if [[ -L "$dst" ]]; then
    # Already a symlink; skip if it already points to skill
    local current
    current="$(readlink "$dst")"
    if [[ "$current" == "$src" ]]; then
      return 0
    fi
    rm -f "$dst"
  fi

  ln -sf "$src" "$dst"
  echo "[ensure-host-deps] LINK $pkg → $src" >&2
}

ensure_bin_symlink() {
  local bin_name="$1"
  local src="$SKILL_NM/.bin/$bin_name"
  local dst="$HOST_NM/.bin/$bin_name"

  if [[ ! -x "$src" ]]; then
    return 0
  fi

  if [[ ! -d "$HOST_NM/.bin" ]]; then
    mkdir -p "$HOST_NM/.bin"
  fi

  if [[ -L "$dst" ]]; then
    local current
    current="$(readlink "$dst")"
    if [[ "$current" == "$src" ]]; then
      return 0
    fi
    rm -f "$dst"
  fi

  ln -sf "$src" "$dst"
}

ensure_wdio() {
  for pkg in "${PKGS[@]}"; do
    ensure_symlink "$pkg"
  done

  # .bin stubs for wdio and appium
  ensure_bin_symlink wdio
  ensure_bin_symlink appium

  # Verify
  local wdio_bin="${HOST_NM}/.bin/wdio"
  local appium_bin="${HOST_NM}/.bin/appium"

  if [[ -x "$wdio_bin" && -x "$appium_bin" ]]; then
    echo "[ensure-host-deps] OK — wdio and appium ready via skill symlinks" >&2
    return 0
  fi

  echo "[ensure-host-deps] FAIL — wdio or appium not available after symlinking" >&2
  echo "  wdio: ${wdio_bin} ($(test -x "$wdio_bin" && echo ok || echo missing))" >&2
  echo "  appium: ${appium_bin} ($(test -x "$appium_bin" && echo ok || echo missing))" >&2
  echo "  Run: cd ${SKILL_ROOT} && npm install" >&2
  return 1
}

case "$MODE" in
  wdio|all)
    ensure_wdio
    ;;
  orch)
    echo "[ensure-host-deps] orch 已迁至 Skill 运行时，无需在宿主安装依赖" >&2
    exit 0
    ;;
  *)
    echo "[ensure-host-deps] unknown mode: $MODE (wdio|all)" >&2
    exit 1
    ;;
esac