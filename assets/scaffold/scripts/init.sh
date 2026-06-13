#!/usr/bin/env bash
# Single entry for device E2E: scaffold → discover → probe → plan/run
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source "$(dirname "$0")/lib/common.sh"

echo "[init] ensure skill orchestration runtime..."
ensure_skill_runtime

PLAN_ONLY=0
SEQUENTIAL=0
PHASE=""
USER_INTENT="${E2E_USER_INTENT:-}"

for arg in "$@"; do
  case "$arg" in
    --plan-only) PLAN_ONLY=1 ;;
    --sequential) SEQUENTIAL=1 ;;
    --phase=*) PHASE="${arg#--phase=}" ;;
    *) USER_INTENT="$USER_INTENT $arg" ;;
  esac
done

export E2E_USER_INTENT="${USER_INTENT# }"

run_pre() {
  echo "[init] scaffold (sync-missing)..."
  bash e2e-device/scripts/scaffold.sh --sync-missing
  echo "[init] discover project..."
  orch_cli discover-project >/dev/null
  echo "[init] discover from diff..."
  orch_cli discover-from-diff >/dev/null || true
  echo "[init] discover chaos..."
  orch_cli discover-chaos >/dev/null
  echo "[init] discover cases (union)..."
  orch_cli discover-cases --union >/dev/null
  echo "[init] probe environment..."
  orch_cli probe-env
  echo "[init] present test plan..."
  orch_cli present-test-plan
  # Check for required questions from probe (output printed above for Agent to process)
  # The Agent MUST present these questions to the user before proceeding
  # Required fields: E2E_PAGE_ORIGIN, E2E_CREDENTIALS
}

if [[ "$PLAN_ONLY" == "1" ]]; then
  orch_cli load-local-config >/dev/null 2>&1 || true
  run_pre
  orch_cli plan-only
  exit 0
fi

LOCAL_FILE="e2e-device/.e2e-local.json"
INITIALIZED=0
if [[ -f "$LOCAL_FILE" ]]; then
  if grep -q '"initialized"[[:space:]]*:[[:space:]]*true' "$LOCAL_FILE" 2>/dev/null; then
    INITIALIZED=1
  fi
fi

orch_cli load-local-config >/dev/null 2>&1 || true

# Apply ANDROID_HOME from .e2e-local.json to the current shell
# (load-local-config only affects Node process; this ensures child processes inherit SDK)
if [[ -z "${ANDROID_HOME:-}" && -f "$LOCAL_FILE" ]]; then
  SDK_FROM_LOCAL=$(node -e "
    try{const c=require('$(pwd)/e2e-device/config/local-config').readLocalConfig();
    const h=c?.env?.ANDROID_HOME; if(h)console.log(h)}catch(e){} " 2>/dev/null || true)
  if [[ -n "$SDK_FROM_LOCAL" && -d "$SDK_FROM_LOCAL" ]]; then
    export ANDROID_HOME="$SDK_FROM_LOCAL"
    export ANDROID_SDK_ROOT="$SDK_FROM_LOCAL"
    echo "[init] ANDROID_HOME=${ANDROID_HOME} (from .e2e-local.json)"
  fi
fi

# Apply E2E_CHROMEDRIVER_PATH from .e2e-local.json (preflight auto-download)
if [[ -z "${E2E_CHROMEDRIVER_PATH:-}" && -f "$LOCAL_FILE" ]]; then
  CD_FROM_LOCAL=$(node -e "
    try{const c=require('$(pwd)/e2e-device/config/local-config').readLocalConfig();
    const p=c?.env?.E2E_CHROMEDRIVER_PATH; if(p)console.log(p)}catch(e){} " 2>/dev/null || true)
  if [[ -n "$CD_FROM_LOCAL" && -x "$CD_FROM_LOCAL" ]]; then
    export E2E_CHROMEDRIVER_PATH="$CD_FROM_LOCAL"
    echo "[init] E2E_CHROMEDRIVER_PATH=${E2E_CHROMEDRIVER_PATH} (from .e2e-local.json)"
  fi
fi

if [[ "$INITIALIZED" == "0" || "$PHASE" == "pre" ]]; then
  run_pre
  if [[ "$INITIALIZED" == "0" ]]; then
    echo '{"env":{"E2E_DATA_MODE":"test","E2E_ENABLE_WEB_MOCK":"1"},"initialized":true}' | orch_cli save-local-config
  fi
fi

if [[ -n "$PHASE" && "$PHASE" != "during" ]]; then
  exit 0
fi

RUN_ID="$(orch_cli archive-start '{"source":"init.sh"}' | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.runId||'')})")"
export E2E_RUN_ID="$RUN_ID"
export E2E_ENABLE_WEB_MOCK="${E2E_ENABLE_WEB_MOCK:-1}"
echo "[init] runId=$RUN_ID"

# Sequential mode: auto-start background Appium to avoid port conflicts
E2E_APPIUM_PORT="${E2E_APPIUM_PORT:-4723}"
if [[ "$SEQUENTIAL" == "1" && "${E2E_APPIUM_SKIP_SERVICE:-}" != "0" && -z "${E2E_APPIUM_SKIP_SERVICE:-}" ]]; then
  PORT_PID=$(lsof -ti :$E2E_APPIUM_PORT 2>/dev/null || true)
  if [[ -z "$PORT_PID" ]]; then
      echo "[init] Starting background Appium on port $E2E_APPIUM_PORT for sequential mode..."
      export E2E_APPIUM_SKIP_SERVICE=1
      # Use absolute path to avoid cwd issues in background process
      APPIUM_BIN="$ROOT/node_modules/.bin/appium"
      if [[ ! -x "$APPIUM_BIN" ]]; then
        APPIUM_BIN="$(command -v appium 2>/dev/null || echo '')"
      fi
      ANDROID_HOME="${ANDROID_HOME:-}" ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-}" \
        nohup "$APPIUM_BIN" --log-level warn --port "$E2E_APPIUM_PORT" \
        > /tmp/e2e-appium.log 2>&1 &
      E2E_APPIUM_PID=$!
      echo "[init] Appium PID=$E2E_APPIUM_PID"
      sleep 10
      # Verify startup
      if ! curl -s "http://127.0.0.1:${E2E_APPIUM_PORT}/status" | grep -q '"ready":true' 2>/dev/null; then
        echo "[init] WARNING: Appium may not have started correctly; falling back to service mode"
        unset E2E_APPIUM_SKIP_SERVICE
        cat /tmp/e2e-appium.log | tail -5 2>/dev/null || true
      else
        echo "[init] Appium ready on port $E2E_APPIUM_PORT"
      fi
  fi
fi

STATUS=0
if [[ "$SEQUENTIAL" == "1" ]]; then
  orch_cli run-sequential "$RUN_ID" || STATUS=$?
else
  bash e2e-device/scripts/run-device-e2e.sh "$@" || STATUS=$?
fi

if [[ $STATUS -eq 0 ]]; then
  orch_cli archive-finish passed
else
  orch_cli archive-finish partial
fi

orch_cli publish-reports "$RUN_ID" || true

# Restore screen sleep (was set to stayon during tests)
adb shell svc power stayon false 2>/dev/null || true

# Kill background Appium if we started it
if [[ -n "${E2E_APPIUM_PID:-}" ]]; then
  kill "$E2E_APPIUM_PID" 2>/dev/null || true
  echo "[init] Stopped background Appium (PID=$E2E_APPIUM_PID)"
fi

exit $STATUS
