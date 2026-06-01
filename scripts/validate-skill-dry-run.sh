#!/usr/bin/env bash
# Forbidden hardcoded project tokens in Skill text (templates may use {{VAR}} only)
set -euo pipefail
SKILL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0

bash "$SKILL_ROOT/scripts/ensure-skill-runtime.sh" || FAIL=1

FORBIDDEN=(
  "jian-h5"
  "检瓜子"
  "damageMisapply"
  "xrk-c2b"
  "com.guazi"
  "guazi-cloud"
  "/v2/"
  "误伤申请"
  "JIAN_H5_PREFIX"
)

scan() {
  local file="$1"
  for word in "${FORBIDDEN[@]}"; do
    if grep -qi "$word" "$file" 2>/dev/null; then
      echo "FORBIDDEN [$word] in $file"
      FAIL=1
    fi
  done
}

while IFS= read -r -d '' f; do
  case "$f" in
    */templates/*) continue ;;
    */validate-skill-dry-run.sh) continue ;;
  esac
  scan "$f"
done < <(find "$SKILL_ROOT" -type f \( -name '*.md' -o -name '*.sh' \) -print0)

WEBVIEW_TEMPLATE="$SKILL_ROOT/templates/scaffold/helpers/webview-context.ts"
for sym in getCurrentWebUrl waitForH5Selector; do
  if ! grep -q "export async function ${sym}" "$WEBVIEW_TEMPLATE" 2>/dev/null; then
    echo "MISSING export ${sym} in $WEBVIEW_TEMPLATE"
    FAIL=1
  fi
done

if [[ $FAIL -ne 0 ]]; then
  echo "validate-skill-dry-run: FAILED"
  exit 1
fi
echo "validate-skill-dry-run: OK"
