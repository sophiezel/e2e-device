#!/usr/bin/env bash
# Copy golden templates into target repo e2e-device/
set -euo pipefail
TARGET="${1:-.}"
SKILL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE_ROOT="$SKILL_ROOT/assets/scaffold"

if [[ ! -d "$TEMPLATE_ROOT" ]]; then
  echo "Missing templates: $TEMPLATE_ROOT" >&2
  exit 1
fi

mkdir -p "$TARGET/e2e-device"
rsync -a \
  "$TEMPLATE_ROOT/" "$TARGET/e2e-device/" 2>/dev/null || \
  cp -R "$TEMPLATE_ROOT/"* "$TARGET/e2e-device/" 2>/dev/null || true

echo "render-scaffold: synced infrastructure to $TARGET/e2e-device"
