#!/usr/bin/env bash
# Keep templates/e2e-device in sync with templates/scaffold (dev-only).
set -euo pipefail
SKILL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$SKILL_ROOT/templates/scaffold"
DEST="$SKILL_ROOT/templates/e2e-device"

if [[ ! -d "$SRC" ]]; then
  echo "missing $SRC" >&2
  exit 1
fi

rsync -a --delete \
  --exclude 'specs/' \
  --exclude 'pageobjects/' \
  --exclude 'fixtures/' \
  --exclude 'resilience/fixture-map.ts' \
  --exclude 'resilience/auto-fix.ts' \
  --exclude 'resilience/classifier.ts' \
  "$SRC/" "$DEST/"

echo "[sync-legacy-templates] $DEST <- $SRC"
