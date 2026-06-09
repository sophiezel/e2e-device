#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source "$(dirname "$0")/lib/common.sh"

# Apply persisted local config (non-sensitive keys only)
if [[ -f e2e-device/scripts/load-local-config.sh ]]; then
  bash e2e-device/scripts/load-local-config.sh >/dev/null 2>&1 || true
fi

# Priority: existing env > .e2e-local.json > adb inference
if [[ -z "${ANDROID_HOME:-}" && -f e2e-device/.e2e-local.json ]]; then
  SDK_FROM_LOCAL=$(node -e "
    try{const c=require('$(pwd)/e2e-device/config/local-config').readLocalConfig();
    const h=c?.env?.ANDROID_HOME; if(h)console.log(h)}catch(e){} " 2>/dev/null || true)
  if [[ -n "$SDK_FROM_LOCAL" && -d "$SDK_FROM_LOCAL" ]]; then
    export ANDROID_HOME="$SDK_FROM_LOCAL"
    export ANDROID_SDK_ROOT="$SDK_FROM_LOCAL"
  fi
fi

# 从 adb 推断 ANDROID_HOME（与 helpers/android-sdk.ts 逻辑一致）
if [[ -z "${ANDROID_HOME:-}" && -x "$(command -v adb)" ]]; then
  ADB_BIN="$(command -v adb)"
  PLATFORM_TOOLS="$(cd "$(dirname "$ADB_BIN")" && pwd)"
  if [[ "$(basename "$PLATFORM_TOOLS")" == "platform-tools" ]]; then
    export ANDROID_HOME="$(cd "$PLATFORM_TOOLS/.." && pwd)"
    export ANDROID_SDK_ROOT="$ANDROID_HOME"
  fi
fi

if [[ -z "${E2E_ACCOUNT:-}" || -z "${E2E_PASSWORD:-}" ]]; then
  echo "Warning: E2E_ACCOUNT / E2E_PASSWORD not set — will skip auto-login if app already logged in." >&2
fi

if [[ "${INSTALL_APK:-0}" == "1" && -f e2e-device/scripts/install-apk.sh ]]; then
  bash e2e-device/scripts/install-apk.sh
fi

if [[ "${PREPARE_DEVICE:-0}" == "1" && -f e2e-device/scripts/prepare-device.sh ]]; then
  bash e2e-device/scripts/prepare-device.sh
fi

export E2E_DATA_MODE="${E2E_DATA_MODE:-test}"
export E2E_RESILIENCE="${E2E_RESILIENCE:-1}"
export E2E_RESILIENCE_AUTOFIX_SRC="${E2E_RESILIENCE_AUTOFIX_SRC:-0}"

echo "ANDROID_HOME=${ANDROID_HOME:-<unset>}"
echo "E2E_DATA_MODE=$E2E_DATA_MODE"
echo "E2E_RESILIENCE=$E2E_RESILIENCE"
echo "ANDROID_UDID=${ANDROID_UDID:-<default>}"

run_wdio "$@"
