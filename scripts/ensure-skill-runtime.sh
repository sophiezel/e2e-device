#!/usr/bin/env bash
# Install orchestration deps into the skill directory (shared across all host repos).
set -euo pipefail

SKILL_ROOT="${E2E_DEVICE_SKILL_ROOT:-${HOME}/.agents/skills/e2e-device}"
cd "$SKILL_ROOT"

AUTO_INSTALL="${E2E_AUTO_INSTALL_SKILL_RUNTIME:-1}"
TS_NODE="${SKILL_ROOT}/scripts/node_modules/.bin/ts-node"

if [[ -x "$TS_NODE" ]]; then
  exit 0
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

echo "[skill-runtime] installing orchestration deps in ${SKILL_ROOT}..."
if command -v npm >/dev/null 2>&1; then
  npm install
elif command -v yarn >/dev/null 2>&1; then
  yarn install
else
  echo "[skill-runtime] npm/yarn not found" >&2
  exit 1
fi

if [[ ! -x "$TS_NODE" ]]; then
  echo "[skill-runtime] install finished but ts-node still missing" >&2
  exit 1
fi
