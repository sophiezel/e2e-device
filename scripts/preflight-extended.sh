#!/usr/bin/env bash
# Optional manual diagnostic tool (NOT called by run.sh).
# Primary preflight lives in run.sh + cli.ts preflight / probe-env.
#
# Usage:
#   bash preflight-extended.sh <package_name> <page_origin>
#
# Exits 1 if any critical check fails.
# Outputs a JSON summary object at the end.
set -euo pipefail

PACKAGE_NAME="$1"
PAGE_ORIGIN="$2"

# ── State collectors ──
WEBVIEW_AVAILABLE=false
WEBVIEW_WARNING=""
PAGE_ORIGIN_CODE=""
PAGE_ORIGIN_OK=false
GRANTED_PERMS=()
FAILED_PERMS=()
DEVICE_MANUFACTURER=""
DEVICE_MODEL=""
DEVICE_ANDROID=""
DEVICE_WEBVIEW_VERSION=""
LOGIN_STATE="unknown"
CRITICAL_FAILURES=0

echo "[preflight-extended] starting checks for package=$PACKAGE_NAME pageOrigin=$PAGE_ORIGIN" >&2

# ─────────────────────────────────────────────────────────────
# 1. WebView Debug Check
# ─────────────────────────────────────────────────────────────
echo "[preflight-extended] checking WebView debug..." >&2

if adb shell "dumpsys package $PACKAGE_NAME | grep -i webview" > /dev/null 2>&1; then
  WEBVIEW_AVAILABLE=true
  echo "[preflight-extended]   WebView package detected" >&2
else
  WEBVIEW_AVAILABLE=false
  echo "[preflight-extended]   WebView package NOT detected in app" >&2
fi

if adb shell "cat /proc/net/unix 2>/dev/null | grep webview_devtools_remote" > /dev/null 2>&1; then
  echo "[preflight-extended]   WebView debug socket found" >&2
else
  WEBVIEW_WARNING="WebView调试可能未开启，请使用debug构建包"
  echo "[preflight-extended]   WARNING: $WEBVIEW_WARNING" >&2
fi

# ─────────────────────────────────────────────────────────────
# 2. pageOrigin Reachability
# ─────────────────────────────────────────────────────────────
echo "[preflight-extended] checking pageOrigin reachability..." >&2

if [[ -n "$PAGE_ORIGIN" ]]; then
  PAGE_ORIGIN_CODE=$(adb shell "curl -o /dev/null -s -w '%{http_code}' --connect-timeout 5 '$PAGE_ORIGIN'" 2>/dev/null || echo "000")
  PAGE_ORIGIN_CODE=$(echo "$PAGE_ORIGIN_CODE" | tr -d '[:space:]')

  if [[ -z "$PAGE_ORIGIN_CODE" || "$PAGE_ORIGIN_CODE" == "000" ]]; then
    echo "[preflight-extended]   WARNING: 设备无法访问pageOrigin，请检查网络/VPN" >&2
    echo "[preflight-extended]   pageOrigin returned: $PAGE_ORIGIN_CODE" >&2
    PAGE_ORIGIN_OK=false
  elif [[ "$PAGE_ORIGIN_CODE" =~ ^[23][0-9][0-9]$ ]]; then
    echo "[preflight-extended]   pageOrigin reachable (HTTP $PAGE_ORIGIN_CODE)" >&2
    PAGE_ORIGIN_OK=true
  else
    echo "[preflight-extended]   pageOrigin returned unexpected code: $PAGE_ORIGIN_CODE" >&2
    PAGE_ORIGIN_OK=false
  fi
else
  PAGE_ORIGIN_CODE=""
  PAGE_ORIGIN_OK=false
  echo "[preflight-extended]   pageOrigin empty, skipping reachability check" >&2
fi

# ─────────────────────────────────────────────────────────────
# 3. Permission Pre-grant
# ─────────────────────────────────────────────────────────────
echo "[preflight-extended] pre-granting permissions..." >&2

PERMISSIONS=(
  "ACCESS_FINE_LOCATION"
  "ACCESS_COARSE_LOCATION"
  "CAMERA"
  "READ_EXTERNAL_STORAGE"
  "WRITE_EXTERNAL_STORAGE"
  "RECORD_AUDIO"
  "POST_NOTIFICATIONS"
)

for perm in "${PERMISSIONS[@]}"; do
  if adb shell "pm grant $PACKAGE_NAME android.permission.$perm" 2>/dev/null; then
    GRANTED_PERMS+=("$perm")
    echo "[preflight-extended]   granted: $perm" >&2
  else
    FAILED_PERMS+=("$perm")
    echo "[preflight-extended]   failed/not-found: $perm" >&2
  fi
done

# ─────────────────────────────────────────────────────────────
# 4. Device Info Collection
# ─────────────────────────────────────────────────────────────
echo "[preflight-extended] collecting device info..." >&2

DEVICE_MANUFACTURER=$(adb shell getprop ro.product.manufacturer 2>/dev/null | tr -d '[:space:]' || echo "unknown")
DEVICE_MODEL=$(adb shell getprop ro.product.model 2>/dev/null | tr -d '[:space:]' || echo "unknown")
DEVICE_ANDROID=$(adb shell getprop ro.build.version.release 2>/dev/null | tr -d '[:space:]' || echo "unknown")
DEVICE_WEBVIEW_VERSION=$(adb shell dumpsys package com.google.android.webview 2>/dev/null | grep versionName | tr -d '[:space:]' | head -1 | sed 's/^[^=]*=//' || echo "unknown")

echo "[preflight-extended]   manufacturer=$DEVICE_MANUFACTURER model=$DEVICE_MODEL android=$DEVICE_ANDROID webview=$DEVICE_WEBVIEW_VERSION" >&2

# ─────────────────────────────────────────────────────────────
# 5. Login State Detection
# ─────────────────────────────────────────────────────────────
echo "[preflight-extended] detecting login state..." >&2

WINDOW_STATE=$(adb shell dumpsys window windows 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' || echo "")

if echo "$WINDOW_STATE" | grep -qi "LoginActivity"; then
  LOGIN_STATE="login_screen"
  echo "[preflight-extended]   login screen detected" >&2
elif echo "$WINDOW_STATE" | grep -qi "$PACKAGE_NAME"; then
  LOGIN_STATE="likely_logged_in"
  echo "[preflight-extended]   app focused, likely logged in" >&2
else
  LOGIN_STATE="unknown"
  echo "[preflight-extended]   could not determine login state" >&2
fi

# ─────────────────────────────────────────────────────────────
# Output JSON summary
# ─────────────────────────────────────────────────────────────

# Build granted permissions JSON array
GRANTED_JSON="["
FIRST=true
for p in "${GRANTED_PERMS[@]}"; do
  if $FIRST; then FIRST=false; else GRANTED_JSON+=","; fi
  GRANTED_JSON+="\"$p\""
done
GRANTED_JSON+="]"

# Build failed permissions JSON array
FAILED_JSON="["
FIRST=true
for p in "${FAILED_PERMS[@]}"; do
  if $FIRST; then FIRST=false; else FAILED_JSON+=","; fi
  FAILED_JSON+="\"$p\""
done
FAILED_JSON+="]"

# Escape webview_warning for JSON
WARN_JSON="null"
if [[ -n "$WEBVIEW_WARNING" ]]; then
  WARN_ESCAPED=$(printf '%s' "$WEBVIEW_WARNING" | sed 's/\\/\\\\/g; s/"/\\"/g')
  WARN_JSON="\"$WARN_ESCAPED\""
fi

cat <<EOF
{
  "webview_debug": {"available": $WEBVIEW_AVAILABLE, "warning": $WARN_JSON},
  "page_origin_reachable": {"code": "$PAGE_ORIGIN_CODE", "ok": $PAGE_ORIGIN_OK},
  "permissions": {"granted": $GRANTED_JSON, "failed": $FAILED_JSON},
  "device": {"manufacturer": "$DEVICE_MANUFACTURER", "model": "$DEVICE_MODEL", "android": "$DEVICE_ANDROID", "webview": "$DEVICE_WEBVIEW_VERSION"},
  "login_state": "$LOGIN_STATE"
}
EOF

# ─────────────────────────────────────────────────────────────
# Determine exit code
# ─────────────────────────────────────────────────────────────
if ! $WEBVIEW_AVAILABLE && [[ -n "$WEBVIEW_WARNING" ]]; then
  CRITICAL_FAILURES=$((CRITICAL_FAILURES + 1))
fi

if ! $PAGE_ORIGIN_OK && [[ -n "$PAGE_ORIGIN" ]]; then
  CRITICAL_FAILURES=$((CRITICAL_FAILURES + 1))
fi

if [[ "$CRITICAL_FAILURES" -gt 0 ]]; then
  echo "[preflight-extended] $CRITICAL_FAILURES critical check(s) failed, exiting with code 1" >&2
  exit 1
fi

echo "[preflight-extended] all critical checks passed" >&2
exit 0
