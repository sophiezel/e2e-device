#!/usr/bin/env bash
# e2e-device 统一入口 (Skill 级)
# 用法: bash ~/.agents/skills/e2e-device/scripts/run.sh --project <路径> --domain <domain> [--mode quick|resilience]
set -euo pipefail

SKILL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT=""
DOMAIN=""
MODE="quick"
CLEAN=0
PLAN_ONLY=0

show_help() {
  cat <<EOF
e2e-device — Android USB Hybrid 真机 E2E

用法: bash $0 --project <项目路径> [选项]

选项:
  --project <path>   项目根路径 (必须)
  --domain <name>    domain 名称 (不指定则从 skill.project.json 读取)
  --mode <mode>      执行模式: quick(默认) | standard | resilience
  --plan-only        仅生成测试计划, 不执行
  --clean            执行后清理沙箱
  --help             帮助

示例:
  bash $0 --project /path/to/jian-h5
  bash $0 --project /path/to/jian-h5 --domain evaluateRecovery --mode resilience
EOF
  exit 0
}

# 解析参数
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --clean) CLEAN=1; shift ;;
    --plan-only) PLAN_ONLY=1; shift ;;
    --help|-h) show_help ;;
    *) echo "未知选项: $1" >&2; show_help ;;
  esac
done

# 校验
[[ -z "$PROJECT" ]] && { echo "错误: 需要 --project <项目路径>" >&2; exit 1; }
[[ ! -d "$PROJECT" ]] && { echo "错误: 项目路径不存在: $PROJECT" >&2; exit 1; }

PROJECT_JSON="$PROJECT/e2e-device/skill.project.json"
[[ ! -f "$PROJECT_JSON" ]] && { echo "错误: 未找到 $PROJECT_JSON" >&2; exit 1; }

# 读取 domain
if [[ -z "$DOMAIN" ]]; then
  DOMAIN=$(node -e "try{const j=require('$PROJECT_JSON');console.log(j.domain||j.pilot?.domain||'')}catch(e){}" 2>/dev/null || echo "")
  [[ -z "$DOMAIN" ]] && { echo "错误: 无法从 skill.project.json 读取 domain, 请用 --domain 指定" >&2; exit 1; }
fi

RUN_ID="$(date +%Y%m%d-%H%M%S)-$((RANDOM % 1000))"
_TMP="${E2E_TMPDIR:-${TMPDIR:-/tmp}}"
_TMP="${_TMP%/}"
SHARED="$_TMP/e2e-device/shared"
SANDBOX="$_TMP/e2e-device/$(basename "$PROJECT")/$DOMAIN"

export E2E_PROJECT_ROOT="$PROJECT"
export E2E_DOMAIN="$DOMAIN"
export E2E_RUN_ID="$RUN_ID"
export E2E_RUN_PROFILE="$MODE"

echo "═══════════════════════════════════════════════════════════════"
echo "  e2e-device"
echo "  项目:   $PROJECT"
echo "  Domain: $DOMAIN"
echo "  模式:   $MODE"
echo "  RunID:  $RUN_ID"
echo "  沙箱:   $SANDBOX"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ─── 1. 检查 Skill 运行时依赖 ───
echo "[init] 检查 Skill 运行时..."
bash "$SKILL_ROOT/scripts/ensure-skill-runtime.sh"

# ─── 2. 创建 shared/ (框架层, 首次创建后复用) ───
setup_shared() {
  if [[ -d "$SHARED/helpers" ]]; then
    echo "[init] shared/ 已就绪, 跳过创建"
    return 0
  fi
  echo "[init] 创建 shared/ 框架层..."
  mkdir -p "$SHARED"

  # symlink 框架目录
  for dir in helpers config orchestration resilience inject chaos scripts; do
    if [[ -d "$SKILL_ROOT/$dir" ]]; then
      ln -sfn "$SKILL_ROOT/$dir" "$SHARED/$dir"
    fi
  done

  # 生成 wdio.conf.ts (从沙箱模板)
  cp "$SKILL_ROOT/templates/wdio.conf.sandbox.ts" "$SHARED/wdio.conf.ts"

  # 生成 tsconfig.json
  cat > "$SHARED/tsconfig.json" <<EOF
{
  "extends": "$SKILL_ROOT/templates/tsconfig.base.json",
  "include": ["specs/**/*.ts"]
}
EOF

  echo "[init] shared/ 创建完成"
}

setup_shared

# ─── 3. 创建 sandbox (增量模式: 保留已有 specs) ───
echo "[init] 准备 sandbox: $SANDBOX"
if [[ ! -d "$SANDBOX" ]]; then
  mkdir -p "$SANDBOX"/{specs,artifacts/runs/$RUN_ID}
  echo "[init] 新建 sandbox"
else
  # 增量模式: 只清 artifacts, 保留 specs
  rm -rf "$SANDBOX/artifacts"
  mkdir -p "$SANDBOX/artifacts/runs/$RUN_ID"
  echo "[init] 复用 sandbox (保留 $(ls "$SANDBOX/specs" 2>/dev/null | wc -l | tr -d ' ') 个已有 spec)"
fi
export E2E_SANDBOX="$SANDBOX"

# symlink 框架层
for dir in helpers config orchestration resilience inject chaos; do
  ln -sfn "$SHARED/$dir" "$SANDBOX/$dir"
done
ln -sfn "$SHARED/wdio.conf.ts" "$SANDBOX/wdio.conf.ts"
ln -sfn "$SHARED/tsconfig.json" "$SANDBOX/tsconfig.json"
ln -sfn "$PROJECT_JSON" "$SANDBOX/skill.project.json"

# symlink 报告输出
REPORTS_DIR="$PROJECT/docs/guazi-flow"
if [[ -d "$REPORTS_DIR" ]]; then
  TASK_DIR=$(find "$REPORTS_DIR" -maxdepth 1 -type d -name "*$DOMAIN*" 2>/dev/null | head -1)
  if [[ -n "$TASK_DIR" ]]; then
    mkdir -p "$TASK_DIR/e2e-device"
    rm -f "$SANDBOX/reports" 2>/dev/null
    ln -sfn "$TASK_DIR/e2e-device" "$SANDBOX/reports"
  fi
fi
if [[ ! -e "$SANDBOX/reports" ]]; then
  mkdir -p "$SANDBOX/reports"
fi

# ─── 4. 生成/增量更新 specs ───
echo "[init] 生成测试用例..."
cd "$SANDBOX"
export PATH="$SKILL_ROOT/node_modules/.bin:$PATH"

# 运行 discover-cases 生成 case-registry (specs 写入项目目录)
npx ts-node "$SKILL_ROOT/orchestration/cli.ts" discover-cases --union --domain "$DOMAIN" 2>&1 | tail -3

# 从项目同步新生成的 specs 到 sandbox (增量: 只复制缺失的)
if [[ -d "$PROJECT/e2e-device/specs" ]]; then
  NEW_COUNT=0
  for src in "$PROJECT/e2e-device/specs"/*.spec.ts; do
    [[ -f "$src" ]] || continue
    dst="$SANDBOX/specs/$(basename "$src")"
    if [[ ! -f "$dst" ]]; then
      cp "$src" "$dst"
      ((NEW_COUNT++)) || true
    fi
  done
  TOTAL=$(ls "$SANDBOX/specs"/*.spec.ts 2>/dev/null | wc -l | tr -d ' ')
  echo "[init] specs: $TOTAL 个 (新增 $NEW_COUNT)"
fi

# 如果还是没有 specs, 从 case-registry 生成模板
if [[ ! "$(ls -A "$SANDBOX/specs" 2>/dev/null)" ]]; then
  echo "[init] 从 matrix 生成 spec 骨架..."
  npx ts-node "$SKILL_ROOT/orchestration/cli.ts" discover-cases --union --domain "$DOMAIN" 2>&1 | tail -3
  # discover-cases 内部调用了 writeGeneratedSpecs → 写入项目 e2e-device/specs
  if [[ -d "$PROJECT/e2e-device/specs" ]]; then
    cp "$PROJECT/e2e-device/specs"/*.spec.ts "$SANDBOX/specs/" 2>/dev/null || true
  fi
  echo "[init] 已生成 $(ls "$SANDBOX/specs" | wc -l | tr -d ' ') 个 spec 骨架"
fi

# ─── 5. 展示计划 ───
echo ""
echo "[init] 测试计划:"
npx ts-node "$SKILL_ROOT/orchestration/cli.ts" present-test-plan 2>&1 | head -20
echo ""

[[ "$PLAN_ONLY" == "1" ]] && { echo "[init] --plan-only, 退出"; exit 0; }

# ─── 6. 启动 Appium (如需要) ───
if [[ "${E2E_APPIUM_SKIP_SERVICE:-}" != "1" ]]; then
  if ! curl -s "http://127.0.0.1:${E2E_APPIUM_PORT:-4723}/status" | grep -q '"ready":true' 2>/dev/null; then
    echo "[init] 启动 Appium (port ${E2E_APPIUM_PORT:-4723})..."
    nohup npx appium --log-level warn --port "${E2E_APPIUM_PORT:-4723}" > /tmp/e2e-appium.log 2>&1 &
    E2E_APPIUM_PID=$!
    sleep 8
    if curl -s "http://127.0.0.1:${E2E_APPIUM_PORT:-4723}/status" | grep -q '"ready":true' 2>/dev/null; then
      echo "[init] Appium 就绪"
      export E2E_APPIUM_SKIP_SERVICE=1
    else
      echo "[init] Appium 启动失败, 将使用 wdio service 模式"
      cat /tmp/e2e-appium.log | tail -3 2>/dev/null || true
    fi
  else
    echo "[init] Appium 已运行, 跳过启动"
    export E2E_APPIUM_SKIP_SERVICE=1
  fi
fi

# ─── 7. 执行 ───
echo ""
echo "[init] 开始执行测试..."
STATUS=0

# 记录开始
npx ts-node "$SKILL_ROOT/orchestration/cli.ts" archive-start "{\"source\":\"run.sh\",\"project\":\"$PROJECT\",\"domain\":\"$DOMAIN\"}" 2>&1 | tail -1

# 或直接调用 wdio
npx wdio run wdio.conf.ts 2>&1 || STATUS=$?

# ─── 8. 发布报告 ───
echo ""
echo "[init] 发布报告..."
npx ts-node "$SKILL_ROOT/orchestration/cli.ts" publish-reports "$RUN_ID" 2>&1 | tail -3

# 将报告从 sandbox 复制到项目 docs/
if [[ -f "$SANDBOX/artifacts/runs/$RUN_ID/cases-executed.jsonl" ]]; then
  echo "[init] 产物: $SANDBOX/artifacts/runs/$RUN_ID/"
fi

if [[ -d "$SANDBOX/reports" ]] && [[ "$(ls -A "$SANDBOX/reports" 2>/dev/null)" ]]; then
  echo "[init] 报告已发布到: $PROJECT/docs/guazi-flow/"
fi

# ─── 9. 清理 ───
# 恢复屏幕休眠
adb shell svc power stayon false 2>/dev/null || true

# 停止 Appium
if [[ -n "${E2E_APPIUM_PID:-}" ]]; then
  kill "$E2E_APPIUM_PID" 2>/dev/null || true
  echo "[init] 已停止 Appium"
fi

if [[ "$CLEAN" == "1" ]]; then
  rm -rf "$SANDBOX"
  echo "[init] 已清理 sandbox"
else
  echo "[init] sandbox 保留: $SANDBOX (下次执行复用, 或 --clean 删除)"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
if [[ $STATUS -eq 0 ]]; then
  echo "  ✅ 测试完成"
else
  echo "  ⚠️  测试完成 (部分失败, exit=$STATUS)"
fi
echo "  RunID: $RUN_ID"
echo "  报告: $PROJECT/docs/guazi-flow/<task>/e2e-device/"
echo "  沙箱: $SANDBOX"
echo "═══════════════════════════════════════════════════════════════"

exit $STATUS
