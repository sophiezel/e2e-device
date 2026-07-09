#!/usr/bin/env bash
# Install orchestration deps into the skill directory (shared across all host repos).
set -euo pipefail

SKILL_ROOT="${E2E_DEVICE_SKILL_ROOT:-${HOME}/.agents/skills/e2e-device}"
cd "$SKILL_ROOT"

AUTO_INSTALL="${E2E_AUTO_INSTALL_SKILL_RUNTIME:-1}"
SCRIPTS_DIR="${SKILL_ROOT}/scripts"
TS_NODE="${SCRIPTS_DIR}/node_modules/.bin/ts-node"
WDIO_RUNNER="${SCRIPTS_DIR}/node_modules/@wdio/local-runner/build/run.js"
WDIO_CLI="${SCRIPTS_DIR}/node_modules/@wdio/cli/bin/wdio.js"

_runtime_ok() {
  [[ -x "$TS_NODE" ]] && [[ -f "$WDIO_RUNNER" ]] && [[ -f "$WDIO_CLI" ]]
}

if _runtime_ok; then
  exit 0
fi

if [[ -x "$TS_NODE" ]]; then
  echo "[skill-runtime] ts-node present but @wdio packages incomplete — reinstalling..."
fi

if [[ ! -f package.json ]]; then
  echo "[e2e-device] skill runtime: missing ${SKILL_ROOT}/package.json" >&2
  exit 1
fi

if [[ "$AUTO_INSTALL" != "1" ]]; then
  echo "" >&2
  echo "[e2e-device] Skill 编排依赖未安装，请在 Skill 目录执行：" >&2
  echo "  cd \"${SKILL_ROOT}\" && npm install" >&2
  echo "或：export E2E_AUTO_INSTALL_SKILL_RUNTIME=1" >&2
  echo "" >&2
  exit 1
fi

echo "[skill-runtime] installing orchestration deps in ${SKILL_ROOT}/scripts..."
if command -v npm >/dev/null 2>&1; then
  cd "$SKILL_ROOT/scripts" && npm install
elif command -v yarn >/dev/null 2>&1; then
  cd "$SKILL_ROOT/scripts" && yarn install
else
  echo "[skill-runtime] npm/yarn not found" >&2
  exit 1
fi

if [[ ! -x "$TS_NODE" ]] || [[ ! -f "$WDIO_RUNNER" ]]; then
  echo "[skill-runtime] install finished but runtime still incomplete (ts-node or @wdio/local-runner)" >&2
  exit 1
fi
