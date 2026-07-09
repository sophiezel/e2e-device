#!/usr/bin/env bash
# 列出跑测前置配置候选（pageOrigin / appPackage / domain），供 Agent AskQuestion 前自查。
# 用法:
#   bash scripts/list-preconfig.sh --project /path/to/project [--domain hint]
# 输出: JSON（stdout）
set -euo pipefail

SKILL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT=""
DOMAIN_HINT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --domain) DOMAIN_HINT="$2"; shift 2 ;;
    -h|--help)
      echo "用法: bash list-preconfig.sh --project <path> [--domain <hint>]"
      exit 0
      ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

[[ -z "$PROJECT" ]] && { echo "错误: 需要 --project <项目路径>" >&2; exit 1; }
[[ ! -d "$PROJECT" ]] && { echo "错误: 项目路径不存在: $PROJECT" >&2; exit 1; }

E2E_HOME="${E2E_HOME:-$HOME/.e2e-device}"
export E2E_HOME
export E2E_PROJECT_ROOT="$PROJECT"
# 临时沙箱，避免污染正式 run 沙箱
export E2E_SANDBOX="${E2E_SANDBOX:-$E2E_HOME/.list-preconfig-$$}"
mkdir -p "$E2E_SANDBOX"

ARGS=(list-preconfig)
[[ -n "$DOMAIN_HINT" ]] && ARGS+=(--domain "$DOMAIN_HINT")

cleanup() { rm -rf "$E2E_SANDBOX" 2>/dev/null || true; }
trap cleanup EXIT

"$SKILL_ROOT/scripts/node_modules/.bin/ts-node" \
  "$SKILL_ROOT/assets/scaffold/orchestration/cli.ts" \
  "${ARGS[@]}"
