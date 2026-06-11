#!/usr/bin/env bash
# e2e-device 自测 Loop
# 用法: bash scripts/self-test-loop.sh [--project <path>]
#       不指定 --project 则交互引导输入
set -euo pipefail

SKILL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_PROJECT=""
LOOP_COUNT=0
MAX_LOOPS=5
ISSUES_FILE="$SKILL_ROOT/docs/plan/self-test-issues-archive.md"
TEST_TMP="$SKILL_ROOT/.self-test-tmp"
rm -rf "$TEST_TMP"
mkdir -p "$TEST_TMP"
trap 'rm -rf "$TEST_TMP" ~/.e2e-device "$TEST_PROJECT/e2e-device"' EXIT

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0
ISSUES=()

# ─── 解析参数 ───
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) TEST_PROJECT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# 引导用户输入测试项目
if [[ -z "$TEST_PROJECT" ]]; then
  echo "请输入测试目标项目路径:"
  [[ -t 0 ]] && read -r TEST_PROJECT
fi
[[ -z "$TEST_PROJECT" ]] && { echo "错误: 需要 --project <项目路径>" >&2; exit 1; }
TEST_PROJECT="$(cd "$TEST_PROJECT" 2>/dev/null && pwd || echo "$TEST_PROJECT")"
[[ ! -d "$TEST_PROJECT" ]] && { echo "错误: 项目路径不存在: $TEST_PROJECT" >&2; exit 1; }
echo "测试项目: $TEST_PROJECT"
echo ""

pass() { echo -e "  ${GREEN}✅${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "  ${RED}❌${NC} $1"; FAIL=$((FAIL+1)); ISSUES+=("$1"); }

# ─── 清理 ───
clean_all() {
  echo "=== 清理所有产物 ==="
  rm -rf ~/.e2e-device "$TEST_PROJECT/e2e-device" "$TEST_TMP"/* 2>/dev/null
  echo ""
}

# ─── 准备测试项目配置 ───
seed_config() {
  if [[ -f "$TEST_PROJECT/e2e-device/skill.project.json" ]]; then
    return 0
  fi
  mkdir -p "$TEST_PROJECT/e2e-device"
  # 尝试从 git 恢复
  cd "$TEST_PROJECT"
  local hash=$(git log --all --oneline -- e2e-device/skill.project.json 2>/dev/null | head -1 | awk '{print $1}')
  if [[ -n "$hash" ]]; then
    git show "$hash:e2e-device/skill.project.json" > "$TEST_PROJECT/e2e-device/skill.project.json" 2>/dev/null && return 0
  fi
  # 创建最小配置 (自测用)
  cat > "$TEST_PROJECT/e2e-device/skill.project.json" <<'EOF'
{ "id": "test-project", "pilot": { "domain": "evaluateRecovery" }, "hybrid": { "platform": "android", "network": { "pageOrigin": "https://test.example.com" } } }
EOF
  echo "  ⚠️  已创建最小测试配置, 部分测试可能受限"
}

# ─── 检查 ───
check_project_clean() {
  local files=$(find "$TEST_PROJECT/e2e-device" -type f 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$files" == "0" ]]; then
    pass "项目残留: 0 文件"
  else
    fail "项目残留: $files 文件 $(find "$TEST_PROJECT/e2e-device" -type f 2>/dev/null | head -3)"
    find "$TEST_PROJECT/e2e-device" -type f -delete 2>/dev/null || true
  fi
}

check_cache_exists() {
  if ls ~/.e2e-device/projects/*.json 2>/dev/null | grep -q .; then
    pass "配置缓存存在"
  else
    fail "配置缓存缺失"
  fi
}

check_sandbox_specs() {
  local count=$(find ~/.e2e-device/sandbox -name "*.spec.ts" 2>/dev/null | wc -l | tr -d ' ')
  # 最小配置生成端侧 spec (7个), 完整配置生成业务 spec (>=25)
  if [[ "$count" -ge 5 ]]; then
    pass "沙箱 specs: $count 个 (>=5)"
  else
    fail "沙箱 specs: $count 个 (<5)"
  fi
}

check_info_clean() {
  local output=$("$SKILL_ROOT/bin/e2e-device.js" info 2>&1)
  if echo "$output" | grep -q "dbug\|error\|Error"; then
    fail "info 输出有污染: $(echo "$output" | grep 'dbug\|error' | head -1)"
  else
    pass "info 输出干净"
  fi
  if echo "$output" | grep -q "Appium\|UIA2\|WebdriverIO\|Node"; then
    pass "info 包含依赖版本"
  else
    fail "info 缺少依赖版本"
  fi
}

check_readme() {
  if [[ -f ~/.e2e-device/README.md ]]; then
    if grep -q "此目录由 e2e-device" ~/.e2e-device/README.md; then
      pass "README.md 存在且内容正确"
    else
      fail "README.md 内容异常"
    fi
  else
    fail "README.md 不存在"
  fi
}

check_report() {
  local reports=$(find "$TEST_PROJECT/docs" -path "*/e2e-device/*.md" -newer /tmp 2>/dev/null | wc -l | tr -d ' ')
  # 报告可能在之前就存在, 不强制要求本次生成
  echo "  ℹ️  报告文件: $reports 个 (历史累计)"
}

# ─── 测试用例 ───

test_01_first_run_with_config() {
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  测试1: 有配置文件的首次运行"
  echo "═══════════════════════════════════════════════════════════════"
  clean_all
  seed_config
  "$SKILL_ROOT/bin/e2e-device.js" plan --project "$TEST_PROJECT" > $TEST_TMP/e2e-test1.log 2>&1 || true
  check_project_clean
  check_cache_exists
  check_sandbox_specs
  # 验证 spec 中包含端侧用例
  local edge_count=$(find ~/.e2e-device/sandbox -name "form-navigation.spec.ts" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$edge_count" -gt 0 ]]; then
    pass "端侧 spec 已包含 (form-navigation 等)"
  else
    fail "端侧 spec 缺失"
  fi
}

test_02_second_run_cache() {
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  测试2: 缓存已存在的二次运行 (不碰项目)"
  echo "═══════════════════════════════════════════════════════════════"
  # 不 clean, 不 seed — 配置已在缓存中
  rm -rf "$TEST_PROJECT/e2e-device" 2>/dev/null  # 模拟项目无 e2e-device/
  "$SKILL_ROOT/bin/e2e-device.js" plan --project "$TEST_PROJECT" > $TEST_TMP/e2e-test2.log 2>&1 || true
  check_project_clean
  check_sandbox_specs
  # 确保没有 "首次运行" 提示 (说明走了缓存)
  if grep -q "首次运行" $TEST_TMP/e2e-test2.log; then
    fail "二次运行不应出现'首次运行'提示"
  else
    pass "二次运行正确使用缓存"
  fi
}

test_03_info() {
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  测试3: info 命令"
  echo "═══════════════════════════════════════════════════════════════"
  check_info_clean
  check_readme
}

test_04_clean() {
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  测试4: clean 命令"
  echo "═══════════════════════════════════════════════════════════════"
  "$SKILL_ROOT/bin/e2e-device.js" clean --all > $TEST_TMP/e2e-test4.log 2>&1 || true
  if [[ ! -d ~/.e2e-device/sandbox ]]; then
    pass "clean --all 删除了 sandbox"
  else
    fail "clean --all 未删除 sandbox"
  fi
  if [[ -d ~/.e2e-device/projects ]] && ls ~/.e2e-device/projects/*.json 2>/dev/null | grep -q .; then
    pass "clean --all 保留了 projects/"
  else
    fail "clean --all 错误删除了 projects/"
  fi
  "$SKILL_ROOT/bin/e2e-device.js" clean --system > $TEST_TMP/e2e-test4b.log 2>&1 || true
  if [[ ! -d ~/.e2e-device ]]; then
    pass "clean --system 完全清除"
  else
    fail "clean --system 未完全清除"
  fi
}

# ─── 存档 ───
archive_issues() {
  if [[ ${#ISSUES[@]} -eq 0 ]]; then
    return
  fi
  local ts=$(date +%Y-%m-%dT%H:%M:%S)
  echo "" >> "$ISSUES_FILE"
  echo "## $ts (Loop #$LOOP_COUNT)" >> "$ISSUES_FILE"
  for issue in "${ISSUES[@]}"; do
    echo "- ❌ $issue" >> "$ISSUES_FILE"
  done
  echo "已存档 ${#ISSUES[@]} 个问题到 $ISSUES_FILE"
}

# ─── 主流程 ───
main() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║           e2e-device 自测 Loop                               ║"
  echo "╚══════════════════════════════════════════════════════════════╝"

  # 确保存档文件存在
  mkdir -p "$(dirname "$ISSUES_FILE")"
  if [[ ! -f "$ISSUES_FILE" ]]; then
    echo "# E2E-Device 自测问题存档" > "$ISSUES_FILE"
    echo "" >> "$ISSUES_FILE"
    echo "> 自动生成, 记录每次自测 loop 发现的问题及修复" >> "$ISSUES_FILE"
    echo "" >> "$ISSUES_FILE"
  fi

  while [[ $LOOP_COUNT -lt $MAX_LOOPS ]]; do
    LOOP_COUNT=$((LOOP_COUNT + 1))
    PASS=0
    FAIL=0
    ISSUES=()

    echo ""
    echo "─────────────────────────────────────────────────────────────"
    echo "  Loop #$LOOP_COUNT / $MAX_LOOPS"
    echo "─────────────────────────────────────────────────────────────"

    test_01_first_run_with_config
    test_02_second_run_cache
    test_03_info
    test_04_clean

    # 汇总
    echo ""
    echo "─────────────────────────────────────────────────────────────"
    echo "  Loop #$LOOP_COUNT 结果: ${GREEN}$PASS passed${NC} / ${RED}$FAIL failed${NC}"
    echo "─────────────────────────────────────────────────────────────"

    if [[ $FAIL -eq 0 ]]; then
      echo ""
      echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
      echo -e "${GREEN}║  🎉 自测通过! 全部 $PASS 项检查通过                           ║${NC}"
      echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
      archive_issues
      rm -rf "$TEST_TMP"
      exit 0
    fi

    archive_issues

    # 有失败 → 等待修复
    echo ""
    echo -e "${YELLOW}发现 $FAIL 个问题, 请修复后按 Enter 继续测试 (或 Ctrl-C 退出)${NC}"
    echo -e "${YELLOW}问题清单:${NC}"
    for issue in "${ISSUES[@]}"; do
      echo "  - $issue"
    done
    [[ -t 0 ]] && read -r
  done

  echo ""
  echo -e "${RED}已达到最大 loop 次数 ($MAX_LOOPS), 仍有 $FAIL 个问题未解决${NC}"
  exit 1
}

main
