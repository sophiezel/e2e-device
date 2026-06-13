#!/usr/bin/env bash
# Generic validation for e2e-device Skill.
# Checks are STRUCTURAL (pattern-based), never project-specific keyword blocklists.
# This script itself must contain zero references to any company/project/domain.
set -euo pipefail
SKILL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0

bash "$SKILL_ROOT/scripts/ensure-skill-runtime.sh" || FAIL=1

# ── Scaffold structural checks ──
# All checks below use pattern matching, not keyword blacklists.
SCAFFOLD_DIR="$SKILL_ROOT/assets/scaffold"
SKILL_SRC_DIRS=("$SCAFFOLD_DIR" "$SKILL_ROOT/scripts" "$SKILL_ROOT/assets")

# Check: no execSync with template literals (should use execFileSync)
if [[ -d "$SCAFFOLD_DIR" ]]; then
  while IFS= read -r -d '' f; do
    if grep -qE 'execSync\(`' "$f" 2>/dev/null; then
      echo "FORBIDDEN execSync with template literal in $f (use execFileSync instead)"
      FAIL=1
    fi
  done < <(find "$SCAFFOLD_DIR" -type f -name '*.ts' -print0)
fi

# Check: no browser.pause() with bare number (should use timeouts config)
if [[ -d "$SCAFFOLD_DIR" ]]; then
  while IFS= read -r -d '' f; do
    if grep -qE 'browser\.pause\([0-9]+\)' "$f" 2>/dev/null; then
      echo "FORBIDDEN browser.pause with bare number in $f (use timeouts config)"
      FAIL=1
    fi
  done < <(find "$SCAFFOLD_DIR" -type f -name '*.ts' -print0)
fi

# Check: no `as never` or `as any` type escapes
if [[ -d "$SCAFFOLD_DIR" ]]; then
  while IFS= read -r -d '' f; do
    if grep -qE 'as never|as any' "$f" 2>/dev/null; then
      echo "FORBIDDEN type escape (as never/as any) in $f"
      FAIL=1
    fi
  done < <(find "$SCAFFOLD_DIR" -type f -name '*.ts' -print0)
fi

# Check: no require() in TS files (ESM only)
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

# Check: TODO count should be minimal
if [[ -d "$SCAFFOLD_DIR" ]]; then
  TODO_COUNT=$(grep -rn '// TODO' "$SCAFFOLD_DIR" --include='*.ts' 2>/dev/null | wc -l | tr -d ' ') || true
  if [[ "$TODO_COUNT" -gt 5 ]]; then
    echo "WARN: $TODO_COUNT TODOs in scaffold (should be ≤5)"
  fi
fi

# Check: inject mock must be purely generic infrastructure (no fixture data)
# Fixture data (tableType, audited, submit.success, etc.) belongs in host repo fixtures/.
INJECT_MOCK="$SKILL_ROOT/assets/scaffold/inject/web-request-mock.js"
if [[ -f "$INJECT_MOCK" ]]; then
  if grep -qE '(tableType|audited|un_audit|getById|submit\.(success|error)|list\.(audited|un_audit))' "$INJECT_MOCK" 2>/dev/null; then
    echo "FORBIDDEN: business fixture data detected in inject mock"
    FAIL=1
  fi
fi

# Check: required exports present in webview-context.ts
WEBVIEW_TEMPLATE="$SKILL_ROOT/assets/scaffold/helpers/webview-context.ts"
for sym in getCurrentWebUrl waitForH5Selector; do
  if ! grep -q "export async function ${sym}" "$WEBVIEW_TEMPLATE" 2>/dev/null; then
    echo "MISSING export ${sym} in $WEBVIEW_TEMPLATE"
    FAIL=1
  fi
done

# ── v2 compliance: no hardcoded framework paths ──

# Check: no hardcoded project-specific subdirectories under docs/
# Detects patterns like docs/<ProjectName>/ or docs/<some-org-flow>/ that
# should use the project's docsPath config instead.
# Matches: docs/ followed by a camelCase or kebab-case name that's not a standard dir
for dir in "${SKILL_SRC_DIRS[@]}"; do
  if [[ -d "$dir" ]]; then
    while IFS= read -r -d '' f; do
      case "$f" in
        *.md|*migration*|*CHANGELOG*|*validate-skill-dry-run*) continue ;;
      esac
      if grep -nHE '["'\'']docs/[a-z]+-[a-z]+' "$f" 2>/dev/null | grep -vE '(node_modules|\.git)' | head -5; then
        echo "FORBIDDEN: hardcoded project-specific docs/ subdirectory in $f (use discover-project docsPath config)"
        FAIL=1
      fi
    done < <(find "$dir" -type f \( -name '*.ts' -o -name '*.js' -o -name '*.sh' \) -not -path '*/node_modules/*' -print0)
  fi
done

# Check: no hardcoded business identifiers in generic code
# Detects strings that look like project-specific domain/module names
# (camelCase compounds of 10+ chars that appear as string literals in path contexts)
for dir in "${SKILL_SRC_DIRS[@]}"; do
  if [[ -d "$dir" ]]; then
    while IFS= read -r -d '' f; do
      case "$f" in
        *.md|*migration*|*CHANGELOG*|*validate-skill-dry-run*) continue ;;
      esac
      if grep -nE "(path\.join|from|require|import).*'[a-z]+[A-Z][a-z]+[A-Z]'" "$f" 2>/dev/null | grep -vE '(node_modules|test|spec|mock|chaos)' | head -5; then
        echo "FORBIDDEN: potential hardcoded business identifier in $f (business data belongs in project config)"
        FAIL=1
      fi
    done < <(find "$dir" -type f \( -name '*.ts' -o -name '*.js' \) -not -path '*/node_modules/*' -print0)
  fi
done

# Check: no project-path writes (e2e-device/specs/, e2e-device/artifacts/ patterns in code)
# v2 sandbox mode: all output goes to E2E_SANDBOX, not the project directory
for dir in "${SKILL_SRC_DIRS[@]}"; do
  if [[ -d "$dir" ]]; then
    while IFS= read -r -d '' f; do
      case "$f" in *validate-skill-dry-run*) continue ;; esac
      if grep -qnE "(path\.join|write|mkdir|outputDir).*['\"]e2e-device/(specs|artifacts)" "$f" 2>/dev/null; then
        echo "FORBIDDEN: project-path write 'e2e-device/specs/' or 'e2e-device/artifacts/' in $f (v2 uses E2E_SANDBOX for all output)"
        FAIL=1
      fi
    done < <(find "$dir" -type f \( -name '*.ts' -o -name '*.js' -o -name '*.sh' \) -not -path '*/node_modules/*' -print0)
  fi
done

if [[ $FAIL -ne 0 ]]; then
  echo "validate-skill-dry-run: FAILED"
  exit 1
fi
echo "validate-skill-dry-run: OK"
