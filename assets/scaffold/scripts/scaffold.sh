#!/usr/bin/env bash
# Render / sync e2e-device infrastructure from skill templates (never overwrite business specs)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SYNC_MISSING=0
for arg in "$@"; do
  case "$arg" in
    --sync-missing) SYNC_MISSING=1 ;;
  esac
done

HOME="${HOME:-}"
SKILL_ROOT="${E2E_DEVICE_SKILL_ROOT:-${DEVICE_E2E_SKILL_TEMPLATES:-$HOME/.agents/skills/e2e-device}}"
SKILL_TEMPLATES="$SKILL_ROOT/assets/scaffold"
REPO_TEMPLATES="$ROOT/e2e-device/templates"

if [[ -d "$SKILL_TEMPLATES" ]]; then
  TEMPLATE_ROOT="$SKILL_TEMPLATES"
elif [[ -d "$REPO_TEMPLATES" ]]; then
  TEMPLATE_ROOT="$REPO_TEMPLATES"
else
  echo "[scaffold] No templates found; skipping (repo already has e2e-device)." >&2
  exit 0
fi

# Infrastructure paths safe to sync (never specs/pageobjects/resilience business)
SAFE_PATHS=(
  "orchestration"
  "inject"
  "scripts/lib"
  "scripts/ensure-host-deps.sh"
  "scripts/init.sh"
  "scripts/scaffold.sh"
  "scripts/run-device-e2e.sh"
  "scripts/probe-env.sh"
  "scripts/check-adb.sh"
  "scripts/install-appium.sh"
  "scripts/install-android-sdk.sh"
  "scripts/publish-reports.sh"
  "scripts/load-local-config.sh"
  "scripts/save-local-config.sh"
  "scripts/discover-project.sh"
  "config/local-config.ts"
  "config/project-manifest.ts"
  "config/run-profile.ts"
  "config/timeouts.ts"
  "helpers/runtime-manifest.ts"
  "helpers/build-h5-url.ts"
  "helpers/auth-detect.ts"
  "helpers/auth-recovery.ts"
  "helpers/credentials.ts"
  "helpers/suite-entry.ts"
  "helpers/ensure-h5-nav-context.ts"
  "helpers/login.ts"
  "helpers/deeplink.ts"
  "helpers/session.ts"
  "helpers/webview-context.ts"
  "helpers/on-failure.ts"
  "helpers/reset-session.ts"
  "helpers/adb.ts"
  "helpers/android-config.ts"
  "helpers/android-sdk.ts"
  "chaos/README.md"
  "README.md"
  ".e2e-local.json.example"
  "skill.project.yaml.example"
  "wdio.conf.template.ts"
  "tsconfig.json"
)

# Resilience files that are generic infrastructure (not business fixture-map)
# 一次性列出所有 orchestration 引用的 resilience 文件
SYNC_RESILIENCE_FILES=(
  "resilience/fixture-loader.ts"
  "resilience/fixture-map.ts"
  "resilience/issue-ledger.ts"
  "resilience/runtime-session.ts"
  "resilience/types.ts"
)

PROTECTED_PREFIXES=(
  "specs/"
  "pageobjects/"
  "resilience/"
  "fixtures/"
)

should_protect() {
  local rel="$1"
  for allowed in "${SYNC_RESILIENCE_FILES[@]}"; do
    if [[ "$rel" == "$allowed" ]]; then
      return 1
    fi
  done
  for p in "${PROTECTED_PREFIXES[@]}"; do
    if [[ "$rel" == "$p"* ]]; then
      return 0
    fi
  done
  return 1
}

copy_if_allowed() {
  local src="$1"
  local rel="${src#$TEMPLATE_ROOT/}"
  if should_protect "$rel"; then
    return
  fi
  local dest="$ROOT/e2e-device/$rel"
  if [[ -f "$dest" && "$SYNC_MISSING" == "1" ]]; then
    return
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  echo "[scaffold] synced $rel"
}

if [[ "$SYNC_MISSING" == "1" ]]; then
  while IFS= read -r -d '' f; do
    copy_if_allowed "$f"
  done < <(find "$TEMPLATE_ROOT" -type f -print0 2>/dev/null || true)
else
  for rel in "${SAFE_PATHS[@]}"; do
    src="$TEMPLATE_ROOT/$rel"
    if [[ -f "$src" ]]; then
      copy_if_allowed "$src"
    elif [[ -d "$src" ]]; then
      while IFS= read -r -d '' f; do
        copy_if_allowed "$f"
      done < <(find "$src" -type f -print0)
    fi
  done
  for rel in "${SYNC_RESILIENCE_FILES[@]}"; do
    src="$TEMPLATE_ROOT/$rel"
    if [[ -f "$src" ]]; then
      copy_if_allowed "$src"
    fi
  done
fi

WDIO_CONF="$ROOT/e2e-device/wdio.conf.ts"
WDIO_TEMPLATE="$ROOT/e2e-device/wdio.conf.template.ts"
if [[ ! -f "$WDIO_CONF" && -f "$WDIO_TEMPLATE" ]]; then
  cp "$WDIO_TEMPLATE" "$WDIO_CONF"
  echo "[scaffold] created wdio.conf.ts from wdio.conf.template.ts"
fi

# Scaffold version — bump this when templates contain breaking changes
SCAFFOLD_VERSION="3"

# Check version mismatch with existing scaffold
VERSION_FILE="$ROOT/e2e-device/.e2e-scaffold-version"
if [[ -f "$VERSION_FILE" && "$SYNC_MISSING" == "1" ]]; then
  EXISTING_VERSION=$(grep -o 'E2E_SCAFFOLD_VERSION=[0-9]*' "$VERSION_FILE" 2>/dev/null | cut -d= -f2 || echo "0")
  if [[ "$EXISTING_VERSION" != "$SCAFFOLD_VERSION" ]]; then
    echo "[scaffold] WARNING: version mismatch (existing=$EXISTING_VERSION, template=$SCAFFOLD_VERSION)" >&2
    echo "[scaffold] Some files may need manual migration. See SKILL.md changelog." >&2
  fi
fi

echo "E2E_SCAFFOLD_VERSION=$SCAFFOLD_VERSION" > "$ROOT/e2e-device/.e2e-scaffold-version"
echo "[scaffold] done (sync-missing=$SYNC_MISSING)"
