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
  if command -v lsof >/dev/null 2>&1; then
    PORT_FREE=$(lsof -i :$E2E_APPIUM_PORT 2>/dev/null || true)
    if [[ -z "$PORT_FREE" ]]; then
      echo "[init] Starting background Appium on port $E2E_APPIUM_PORT for sequential mode..."
      export E2E_APPIUM_SKIP_SERVICE=1
      ANDROID_HOME="${ANDROID_HOME:-}" ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-}" nohup \
        "$(command -v node)" "$(command -v appium || echo e2e-device/node_modules/.bin/appium)" \
        --log-level warn --port "$E2E_APPIUM_PORT" > /tmp/e2e-appium.log 2>&1 &
      E2E_APPIUM_PID=$!
      echo "[init] Appium PID=$E2E_APPIUM_PID"
      sleep 8
      # Verify startup
      if ! curl -s http://127.0.0.1:"$E2E_APPIUM_PORT"/status >/dev/null 2>&1; then
        echo "[init] WARNING: Appium may not have started correctly; falling back to service mode"
        unset E2E_APPIUM_SKIP_SERVICE
      fi
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

# Kill background Appium if we started it
if [[ -n "${E2E_APPIUM_PID:-}" ]]; then
  kill "$E2E_APPIUM_PID" 2>/dev/null || true
  echo "[init] Stopped background Appium (PID=$E2E_APPIUM_PID)"
fi

exit $STATUS
