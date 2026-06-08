#!/usr/bin/env bash
# Forbidden hardcoded project tokens in Skill text (templates may use {{VAR}} only)
set -euo pipefail
SKILL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0

bash "$SKILL_ROOT/scripts/ensure-skill-runtime.sh" || FAIL=1

# ── 主防线：结构性检查（覆盖所有业务特定模式，不依赖具体公司名）──
#   优先依赖下面的 execSync/browser.pause/as never/require 等模式检查
# ── 次防线：历史回归词（防止已修复的硬编码被意外重新引入）──
#   这些词来自 Skill 进化过程中真实发生过泄漏的术语。
#   保留它们作为回归测试——如果这些词再次出现在 Skill 正文中，一定是 Bug。
#   它们永远不会泄漏到宿主项目（此脚本只在 Skill 目录运行）。
FORBIDDEN=(
  "jian-h5"
  "检瓜子"
  "damageMisapply"
  "damageMisApply"
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
    */node_modules/*) continue ;;
    */reference/*) continue ;;
    */docs/*) continue ;;
    */validate-skill-dry-run.sh) continue ;;
  esac
  scan "$f"
done < <(find "$SKILL_ROOT" -type f \( -name '*.md' -o -name '*.sh' -o -name '*.ts' \) -not -path '*/node_modules/*' -print0)

# Special check: inject mock must not contain business-specific hardcoding
# (historical regression words — real fixtures that accidentally leaked into the generic mock layer)
INJECT_MOCK="$SKILL_ROOT/templates/scaffold/inject/web-request-mock.js"
INJECT_FORBIDDEN=(
  "tableType"
  "audited"
  "un_audit"
  "id=999"
  "getById.999"
  "getById.101"
  "submit.success"
  "submit.error"
  "list.audited"
  "list.un_audit"
)
if [[ -f "$INJECT_MOCK" ]]; then
  for word in "${INJECT_FORBIDDEN[@]}"; do
    if grep -q "$word" "$INJECT_MOCK" 2>/dev/null; then
      echo "FORBIDDEN [$word] in $INJECT_MOCK (inject layer must be business-agnostic)"
      FAIL=1
    fi
  done
fi

WEBVIEW_TEMPLATE="$SKILL_ROOT/templates/scaffold/helpers/webview-context.ts"
for sym in getCurrentWebUrl waitForH5Selector; do
  if ! grep -q "export async function ${sym}" "$WEBVIEW_TEMPLATE" 2>/dev/null; then
    echo "MISSING export ${sym} in $WEBVIEW_TEMPLATE"
    FAIL=1
  fi
done

# Check: scaffold files should not use execSync( with template literals (use execFileSync instead)
SCAFFOLD_DIR="$SKILL_ROOT/templates/scaffold"
if [[ -d "$SCAFFOLD_DIR" ]]; then
  while IFS= read -r -d '' f; do
    if grep -qE 'execSync\(`' "$f" 2>/dev/null; then
      echo "FORBIDDEN execSync with template literal in $f (use execFileSync instead)"
      FAIL=1
    fi
  done < <(find "$SCAFFOLD_DIR" -type f -name '*.ts' -print0)
fi

# Check: scaffold files should not use browser.pause( with a bare number (use timeouts config)
if [[ -d "$SCAFFOLD_DIR" ]]; then
  while IFS= read -r -d '' f; do
    if grep -qE 'browser\.pause\([0-9]+\)' "$f" 2>/dev/null; then
      echo "FORBIDDEN browser.pause with bare number in $f (use timeouts config)"
      FAIL=1
    fi
  done < <(find "$SCAFFOLD_DIR" -type f -name '*.ts' -print0)
fi

# Check: scaffold TS files should not use `as never` or `as any` type escapes
if [[ -d "$SCAFFOLD_DIR" ]]; then
  while IFS= read -r -d '' f; do
    if grep -qE 'as never|as any' "$f" 2>/dev/null; then
      echo "FORBIDDEN type escape (as never/as any) in $f"
      FAIL=1
    fi
  done < <(find "$SCAFFOLD_DIR" -type f -name '*.ts' -print0)
fi

# Check: scaffold TS files should not use require() (ESM only)
if [[ -d "$SCAFFOLD_DIR" ]]; then
  while IFS= read -r -d '' f; do
    if grep -qE '\brequire\(' "$f" 2>/dev/null; then
      echo "FORBIDDEN require() in $f (use ES imports instead)"
      FAIL=1
    fi
  done < <(find "$SCAFFOLD_DIR" -type f -name '*.ts' -print0)
fi

# Check: process.exitCode should only be set in cli.ts
if [[ -d "$SCAFFOLD_DIR" ]]; then
  while IFS= read -r -d '' f; do
    case "$f" in
      */cli.ts|*/cli.ts.backup) continue ;;
    esac
    if grep -qE 'process\.exitCode\s*=' "$f" 2>/dev/null; then
      echo "FORBIDDEN process.exitCode direct assignment in $f (should only be in cli.ts)"
      FAIL=1
    fi
  done < <(find "$SCAFFOLD_DIR" -type f -name '*.ts' -print0)
fi

# Check: TODO count in scaffold should be minimal (≤5)
if [[ -d "$SCAFFOLD_DIR" ]]; then
  TODO_COUNT=$(grep -rn '// TODO' "$SCAFFOLD_DIR" --include='*.ts' 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$TODO_COUNT" -gt 5 ]]; then
    echo "WARN: $TODO_COUNT TODOs in scaffold (should be ≤5)"
    # Warning only — not a hard failure
  fi
fi

if [[ $FAIL -ne 0 ]]; then
  echo "validate-skill-dry-run: FAILED"
  exit 1
fi
echo "validate-skill-dry-run: OK"
