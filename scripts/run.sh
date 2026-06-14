#!/usr/bin/env bash
# e2e-device 统一入口 (Skill 级)
# 用法: bash ~/.agents/skills/e2e-device/scripts/run.sh --project <路径> --domain <domain> [--mode quick|resilience]
set -euo pipefail

SKILL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT=""
DOMAIN=""
MODE="standard"
CLEAN=0
PLAN_ONLY=0
AUTO_HEAL="${E2E_AUTO_HEAL:-1}"  # 默认开启自愈

show_help() {
  cat <<EOF
e2e-device — Android USB Hybrid 真机 E2E

用法: bash $0 --project <项目路径> [选项]

选项:
  --project <path>   项目根路径 (必须)
  --domain <name>    domain 名称 (不指定则从 E2E_HOME 缓存自动探测)
  --mode <mode>      执行模式: quick(默认) | standard | resilience
  --plan-only        仅生成测试计划, 不执行
  --clean            执行后清理沙箱
  --help             帮助

示例:
  bash $0 --project /path/to/jian-h5
  bash $0 --project /path/to/jian-h5 --domain myFeature --mode resilience
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

RUN_ID="$(date +%Y%m%d-%H%M%S)-$((RANDOM % 1000))"
E2E_HOME="${E2E_HOME:-$HOME/.e2e-device}"
CACHE_DIR="$E2E_HOME/projects"
SHARED="$E2E_HOME/sandbox/shared"
PROJECT_HASH=$(echo -n "$PROJECT" | base64 | tr '/+=' '_' | cut -c1-32)
SANDBOX="$E2E_HOME/sandbox/$PROJECT_HASH/$DOMAIN"
LOGS_DIR="$E2E_HOME/logs"
GIT_BRANCH="$(git -C "$PROJECT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"
CACHE_JSON="$CACHE_DIR/${PROJECT_HASH}.json"
PROJECT_JSON="$CACHE_JSON"  # 唯一数据源在 E2E_HOME 缓存，不读项目目录

# 从缓存读取（唯一数据源，不读项目目录）
if [[ -f "$CACHE_JSON" ]]; then
  PROJECT_JSON="$CACHE_JSON"
else
  # 配置完全缺失 → 探测+交互引导（写入缓存，不写项目）
  source "$SKILL_ROOT/scripts/probe-config.sh"
  probe_and_configure "$CACHE_JSON" "$PROJECT" "$DOMAIN"
fi

# probe_and_configure 已设置 DOMAIN, 无需再解析
# 只需确保 SANDBOX 是最新的 (probe 内已更新, 此处兜底)
SANDBOX="$E2E_HOME/sandbox/$PROJECT_HASH/$DOMAIN"

# ─── 前置: 创建沙箱 + 设置 E2E_SANDBOX (之后所有操作都在沙箱内) ───
mkdir -p "$SANDBOX"/{specs,artifacts/runs/$RUN_ID}
export E2E_SANDBOX="$SANDBOX"

[[ ! -f "$PROJECT_JSON" ]] && { echo "错误: 配置文件不存在于 E2E_HOME 缓存" >&2; echo "请设置 E2E_PAGE_ORIGIN 环境变量后重试" >&2; exit 1; }


export E2E_PROJECT_ROOT="$PROJECT"
export E2E_DOMAIN="$DOMAIN"
export E2E_RUN_ID="$RUN_ID"
export E2E_RUN_PROFILE="$MODE"
export PATH="$SKILL_ROOT/scripts/node_modules/.bin:$PATH"  # 确保 npx/ts-node 使用 Skill 版本

echo "═══════════════════════════════════════════════════════════════"
echo "  e2e-device"
echo "  项目:   $PROJECT"
echo "  Domain: $DOMAIN"
echo "  模式:   $MODE"
echo "  RunID:  $RUN_ID"
echo "  沙箱:   $SANDBOX"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ─── 1. 检查 Skill 运行时 + 自愈 ───
echo "[init] 检查 Skill 运行时..."
bash "$SKILL_ROOT/scripts/ensure-skill-runtime.sh"

# 自动修复可修复的依赖问题
# ⚠️ 安全边界: 自愈只操作 Skill/E2E_HOME/系统工具, 绝不修改项目业务代码
#    允许: brew install, npm install (skill dir), appium driver install (~/.appium)
#    禁止: 修改 $PROJECT/src, $PROJECT/package.json, $PROJECT/e2e-device/
if [[ "$AUTO_HEAL" == "1" ]]; then
  echo "[init] 自愈检查 (E2E_AUTO_HEAL=1)..."
  "$SKILL_ROOT/scripts/node_modules/.bin/ts-node" "$SKILL_ROOT/assets/scaffold/orchestration/cli.ts" preflight --json 2>/dev/null | \
    node -e "
      const chunks = [];
      process.stdin.on('data', c => chunks.push(c));
      process.stdin.on('end', () => {
        try {
          const r = JSON.parse(Buffer.concat(chunks).toString());
          const fixable = (r.checks||[]).filter(c => c.status !== 'pass' && c.autoFixable);
          if (fixable.length) {
            console.log('[auto-heal] 发现 ' + fixable.length + ' 项可自动修复:');
            fixable.forEach(c => console.log('  - ' + c.name + ': ' + (c.message||'')));
          } else {
            const unfixable = (r.checks||[]).filter(c => c.status === 'fail' && !c.autoFixable);
            if (unfixable.length) {
              console.log('[auto-heal] ' + unfixable.length + ' 项需要手动处理:');
              unfixable.forEach(c => console.log('  ⚠️  ' + c.name + ': ' + (c.message||'') + ' → ' + (c.resolution||'')));
            } else {
              console.log('[auto-heal] 环境健康, 无需修复');
            }
          }
        } catch(e) { console.log('[auto-heal] preflight 解析失败:', e.message); }
      });
    " 2>/dev/null || true
fi

# ─── 1.5 前置检查 (ADB / WebView / pageOrigin / 权限) ───
echo "[preflight] ADB 设备检查..."

# ADB 连接状态验证 + 自动重试（修复频繁 offline 问题）
_verify_adb_device() {
  local max_retries=3
  local retry=0
  while [[ $retry -lt $max_retries ]]; do
    # 检查设备是否存在且状态为 device
    local state
    state=$(adb devices 2>/dev/null | grep -v 'List of' | awk '{if(NF>=2) print $2}' | head -1)
    if [[ "$state" == "device" ]]; then
      # 测试实际连通性
      if adb shell "echo 'alive'" 2>/dev/null | grep -q alive; then
        return 0
      fi
    fi
    retry=$((retry + 1))
    if [[ $retry -lt $max_retries ]]; then
      echo "[preflight] ADB 状态异常(state=$state), 尝试重启 adb server ($retry/$max_retries)..."
      adb kill-server 2>/dev/null || true
      sleep 2
      adb start-server 2>/dev/null || true
      sleep 3
    fi
  done
  return 1
}

if ! _verify_adb_device; then
  # 兜底：列出现有设备信息供排查
  echo "[preflight] 设备列表:" >&2
  adb devices -l 2>/dev/null >&2
  echo "[preflight] 错误: ADB 设备不可用（请解锁手机、检查 USB 调试授权）" >&2
  exit 1
fi

DEVICE_COUNT=$(adb devices 2>/dev/null | grep -c 'device$' || echo 0)
echo "[preflight] 检测到 $DEVICE_COUNT 个 ADB 设备（已验证连通性）"

# 从配置提取包名和 pageOrigin
PKG=$(node -e "try{const j=require('$PROJECT_JSON');process.stdout.write(j.hybrid?.container?.package||'')}catch(e){}" 2>/dev/null)
PAGE_ORIGIN=$(node -e "try{const j=require('$PROJECT_JSON');process.stdout.write(j.hybrid?.network?.pageOrigin||'')}catch(e){}" 2>/dev/null)
echo "[preflight] 包名: ${PKG:-未知}, pageOrigin: ${PAGE_ORIGIN:-未知}"

# WebView debug 检查 (提示)
if [[ -n "$PKG" ]]; then
  echo "[preflight] WebView debug: 需 App 编译时启用 setWebContentsDebuggingEnabled(true)"
fi

# pageOrigin 可达性检查 (设备端 curl)
if [[ -n "$PAGE_ORIGIN" ]]; then
  echo "[preflight] 检查 pageOrigin 可达性 (adb shell curl)..."
  HTTP_CODE=$(adb shell "curl -o /dev/null -s -w '%{http_code}' -m 5 '$PAGE_ORIGIN'" 2>/dev/null | tr -d '\r\n ')
  if [[ "$HTTP_CODE" =~ ^(200|301|302|401|403|404)$ ]]; then
    echo "[preflight] pageOrigin 可达 (HTTP $HTTP_CODE)"
  else
    echo "[preflight] 警告: pageOrigin 不可达 (HTTP ${HTTP_CODE:-timeout}), 测试可能受影响"
  fi
fi

# 权限预授权 (避免运行时弹窗阻断)
if [[ -n "$PKG" ]]; then
  echo "[preflight] 权限预授权..."
  for perm in android.permission.ACCESS_FINE_LOCATION android.permission.ACCESS_COARSE_LOCATION android.permission.CAMERA android.permission.RECORD_AUDIO android.permission.READ_EXTERNAL_STORAGE android.permission.WRITE_EXTERNAL_STORAGE; do
    adb shell pm grant "$PKG" "$perm" 2>/dev/null && echo "[preflight]   $perm" || true
  done
fi
echo ""

# ─── 2. 创建 shared/ (框架层, 首次创建后复用) ───
setup_shared() {
  if [[ -d "$SHARED/helpers" ]]; then
    echo "[init] shared/ 已就绪, 跳过创建"
    return 0
  fi
  echo "[init] 创建 shared/ 框架层..."
  mkdir -p "$SHARED"

  # symlink 框架目录 (v2: all under assets/scaffold/)
  # NOTE: helpers/config 不 symlink——项目 spec 的 helper/配置会反向污染 skill 源码
  #       只 symlink 不会被项目写入的纯框架目录
  for dir in orchestration resilience chaos scripts; do
    if [[ -d "$SKILL_ROOT/assets/scaffold/$dir" ]]; then
      ln -sfn "$SKILL_ROOT/assets/scaffold/$dir" "$SHARED/$dir"
    fi
  done

  # 生成 wdio.conf.ts (从 assets 模板)
  cp "$SKILL_ROOT/assets/wdio.conf.sandbox.ts" "$SHARED/wdio.conf.ts"

  # 生成 tsconfig.json
  cat > "$SHARED/tsconfig.json" <<EOF
{
  "extends": "$SKILL_ROOT/assets/tsconfig.base.json",
  "include": ["specs/**/*.ts"]
}
EOF

  echo "[init] shared/ 创建完成"
}

generate_readme() {
  cat > "$E2E_HOME/README.md" <<'READEOS'
# E2E Device 产物目录

> 此目录由 e2e-device 自动生成和管理。
> 可配置: export E2E_HOME=/your/path

READEOS
  # 动态写入实际路径 (避免 heredoc 展开问题)
  echo "> 位置: $E2E_HOME" >> "$E2E_HOME/README.md"
  cat >> "$E2E_HOME/README.md" <<'READEOS2'

```
~/.e2e-device/
├── README.md           ← 本文件
│
├── projects/           ← [持久化] 项目配置缓存
│   └── {hash}.json     ← 项目配置
│                         内容: 包名/deeplink/domain/pageOrigin/routes
│                         作用: 跨重启持久化, 避免每次 probe
│                         清理: 勿删 (丢失后需重新 probe)
│
├── sandbox/            ← [临时] 测试执行沙箱
│   ├── shared/         ← 框架缓存 (symlink 到 Skill 目录)
│   │   ├── helpers/    → symlink → Skill 通用工具 (login/webview/session...)
│   │   ├── config/     → symlink → Skill 配置模块 (timeouts/app/platform...)
│   │   ├── orchestration/ → symlink → Skill 编排引擎 (probe/discover/run...)
│   │   ├── resilience/ → symlink → Skill 韧性框架 (issue-ledger/diagnostics...)
│   │   ├── inject/     → symlink → Skill WebView Mock 脚本
│   │   ├── chaos/      → symlink → Skill 混沌测试模板
│   │   ├── wdio.conf.ts ← 从 Skill 模板生成 (沙箱模式)
│   │   └── tsconfig.json ← extends Skill tsconfig.base.json
│   │     作用: 跨项目复用, 避免重复创建 symlink
│   │     清理: 可删 (下次 run 自动重建, 耗时 <2s)
│   │
│   └── {项目名}/       ← 项目隔离
│       └── {domain}/   ← 需求隔离 (按 pilot.domain)
│           ├── skill.project.json → symlink → projects/{hash}.json
│           ├── specs/   ← 测试用例 (从 matrix 矩阵 + Skill 模板生成)
│           │   ├── {domain}.C01.spec.ts  ← 验收矩阵用例
│           │   ├── {domain}.hybrid.*.spec.ts ← Hybrid 测试
│           │   └── *.spec.ts ... ← 端侧通用用例
│           ├── case-registry.json ← 用例注册表
│           ├── artifacts/  ← 运行时临时产物
│           │   └── runs/{runId}/
│           │       ├── cases-executed.jsonl  ← 用例执行记录
│           │       ├── diagnostic-snapshots/  ← 失败诊断快照
│           │       └── coverage-snapshots/    ← Istanbul 覆盖率
│           └── reports/ → symlink → 项目 docs/
│
└── logs/               ← [临时] 运行日志
    └── appium.log      ← Appium 服务端日志
                          作用: 调试 Appium 启动/连接问题
                          清理: 可删 (下次 run 自动创建)
```

---

## 清理

| 命令 | 效果 |
|------|------|
| e2e-device clean --sandbox | 删除 sandbox/ (保留配置) |
| e2e-device clean --logs | 删除 logs/ |
| e2e-device clean --all | 删除 sandbox/ + logs/ (保留配置) |
| e2e-device clean --system | 完全清除 ~/.e2e-device/ |
| rm -rf ~/.e2e-device | 等效 --system |

> 系统重启不会自动清理此目录。

---

## 外部依赖

e2e-device 依赖以下外部基础设施 (不受 E2E_HOME 管理):

| 路径 | 内容 | 管理者 | 大小 |
|------|------|--------|------|
| `~/.appium/node_modules/` | Appium uiautomator2 驱动 | `appium driver install` | ~84M |
| `~/.agents/skills/e2e-device/` | Skill 代码 + wdio/appium/ts-node 依赖 | `npm install` | ~500M |
| Android SDK | platform-tools, build-tools | Android Studio / sdkmanager | ~2G |
READEOS2
}

# 生成 README (首次或每次更新)
mkdir -p "$E2E_HOME"
generate_readme

setup_shared

# ─── 3. 准备 sandbox: 区分可写目录(复制) vs 只读框架(symlink) ───
# 原则: 凡是项目 spec 可能写入的目录必须独立，不可 symlink 回 skill 源码
#       只有纯框架代码(不会被写入)的目录才 symlink
#   Writable: helpers, config  — 项目 spec 会写 helper / 可能写配置
#   Read-only: orchestration, resilience, chaos — 纯框架代码
#   Read-only infra: node_modules, tsconfig.json, wdio.conf.ts
echo "[init] 准备 sandbox: $SANDBOX"
if [[ ! -d "$SANDBOX/specs" ]]; then
  echo "[init] 新建 sandbox"
else
  rm -rf "$SANDBOX/artifacts"
  mkdir -p "$SANDBOX/artifacts/runs/$RUN_ID"
  echo "[init] 复用 sandbox (保留 $(ls "$SANDBOX/specs" 2>/dev/null | wc -l | tr -d ' ') 个已有 spec)"
fi

# ── 只读框架目录: symlink（不会被项目写入）───
for dir in orchestration resilience; do
  ln -sfn "$SHARED/$dir" "$SANDBOX/$dir"
done

# ── 可写目录: 独立目录 + 复制框架文件（防止 symlink 污染 skill 源码）───
_setup_writable_dir() {
  local dir="$1"
  local src="$SKILL_ROOT/assets/scaffold/$dir"
  # 如果已是 symlink 则拆除
  if [[ -L "$SANDBOX/$dir" ]]; then
    rm -f "$SANDBOX/$dir"
  fi
  # 创建独立目录（若不存在）
  if [[ ! -d "$SANDBOX/$dir" ]]; then
    mkdir -p "$SANDBOX/$dir"
    # 复制框架文件作为种子
    if [[ -d "$src" ]]; then
      cp -a "$src/"* "$SANDBOX/$dir/" 2>/dev/null || true
      echo "[init] $dir: 独立目录 + $(ls "$src" 2>/dev/null | wc -l | tr -d ' ') 个框架文件"
    fi
  else
    echo "[init] $dir: 复用已有 ($(ls "$SANDBOX/$dir" 2>/dev/null | wc -l | tr -d ' ') 个文件)"
  fi
}
_setup_writable_dir "helpers"
_setup_writable_dir "config"
_setup_writable_dir "chaos"

# ── 只读基础设施: symlink ──
ln -sfn "$SHARED/wdio.conf.ts" "$SANDBOX/wdio.conf.ts"
ln -sfn "$SHARED/tsconfig.json" "$SANDBOX/tsconfig.json"
ln -sfn "$PROJECT_JSON" "$SANDBOX/skill.project.json"

# symlink 报告输出
REPORTS_DIR="${E2E_REPORT_PATH:-$PROJECT/docs}"
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

# ─── 3.5 case cache ───
CASE_CACHE="$E2E_HOME/projects/${PROJECT_HASH}/case-cache/$GIT_BRANCH/$DOMAIN.json"
mkdir -p "$(dirname "$CASE_CACHE")"
CASE_CACHE_HIT=0
if [[ -f "$CASE_CACHE" ]]; then
  echo "[init] case-cache 命中 ($GIT_BRANCH/$DOMAIN)"
  # 从缓存恢复到 sandbox
  CACHE_SPEC_DIR="$(dirname "$CASE_CACHE")"
  for cached_spec in "$CACHE_SPEC_DIR"/*.spec.ts; do
    [[ -f "$cached_spec" ]] || continue
    cp "$cached_spec" "$SANDBOX/specs/" 2>/dev/null || true
  done
  if [[ -f "$CACHE_SPEC_DIR/case-registry.json" ]]; then
    cp "$CACHE_SPEC_DIR/case-registry.json" "$SANDBOX/" 2>/dev/null || true
  fi
  CASE_CACHE_HIT=1
else
  echo "[init] case-cache 未命中 ($GIT_BRANCH/$DOMAIN)"
fi

# ─── 4. 生成/增量更新 specs ───
if [[ "$CASE_CACHE_HIT" == "1" ]]; then
  echo "[init] 复用缓存 cases, 跳过 generation"
  cd "$SANDBOX"
else
  echo "[init] 生成测试用例..."
  cd "$SANDBOX"

# 运行 discover-cases 生成 case-registry (v2: 仅写入沙箱)
"$SKILL_ROOT/scripts/node_modules/.bin/ts-node" "$SKILL_ROOT/assets/scaffold/orchestration/cli.ts" discover-cases --union --domain "$DOMAIN" 2>&1 | tail -3

# v2: zero project writes — specs live only in sandbox
# 始终从 Skill 模板补充端侧通用 spec (增量, 不覆盖已有)
if [[ -d "$SKILL_ROOT/assets/scaffold/specs" ]]; then
  EDGE_NEW=0
  for tmpl in "$SKILL_ROOT/assets/scaffold/specs"/*.spec.ts; do
    [[ -f "$tmpl" ]] || continue
    dst="$SANDBOX/specs/$(basename "$tmpl")"
    if [[ ! -f "$dst" ]]; then
      cp "$tmpl" "$dst"
      ((EDGE_NEW++)) || true
    fi
  done
  [[ $EDGE_NEW -gt 0 ]] && echo "[init] 端侧 spec: +$EDGE_NEW (从 Skill 模板)"
fi
# 保存到 case cache
if [[ "$CASE_CACHE_HIT" == "0" ]]; then
  cp "$SANDBOX/specs"/*.spec.ts "$(dirname "$CASE_CACHE")/" 2>/dev/null || true
  cp "$SANDBOX/case-registry.json" "$(dirname "$CASE_CACHE")/" 2>/dev/null || true
  echo "[init] case-cache 已写入 ($GIT_BRANCH/$DOMAIN)"
fi
fi  # end case-cache else

# ─── 5. 展示计划 ───
echo ""
echo "[init] 测试计划:"
PLAN_OUTPUT=$("$SKILL_ROOT/scripts/node_modules/.bin/ts-node" "$SKILL_ROOT/assets/scaffold/orchestration/cli.ts" present-test-plan 2>&1)
echo "$PLAN_OUTPUT" | head -80
echo ""
# 统计 case 数量
CASE_COUNT=$(echo "$PLAN_OUTPUT" | grep -c '| \[ \]' 2>/dev/null || echo 0)
echo "[init] 共计 $CASE_COUNT 个用例"
echo ""

[[ "$PLAN_ONLY" == "1" ]] && { echo "[init] --plan-only, 退出"; exit 0; }

# ─── 6. 启动 Appium (如需要) ───
if [[ "${E2E_APPIUM_SKIP_SERVICE:-}" != "1" ]]; then
  if ! curl -s "http://127.0.0.1:${E2E_APPIUM_PORT:-4723}/status" | grep -q '"ready":true' 2>/dev/null; then
    echo "[init] 启动 Appium (port ${E2E_APPIUM_PORT:-4723})..."
    mkdir -p "$LOGS_DIR"
  nohup npx appium --log-level warn --port "${E2E_APPIUM_PORT:-4723}" > "$LOGS_DIR/appium.log" 2>&1 &
    E2E_APPIUM_PID=$!
    sleep 8
    if curl -s "http://127.0.0.1:${E2E_APPIUM_PORT:-4723}/status" | grep -q '"ready":true' 2>/dev/null; then
      echo "[init] Appium 就绪"
      export E2E_APPIUM_SKIP_SERVICE=1
    else
      echo "[init] Appium 启动失败, 将使用 wdio service 模式"
      cat "$LOGS_DIR/appium.log" | tail -3 2>/dev/null || true
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

# 记录开始 + 触达进度介质 (progress.jsonl)
echo '{"ts":'$(date +%s%3N)',"seq":0,"caseId":"__run__","status":"running","desc":"Run started"}' >> "$SANDBOX/artifacts/runs/$RUN_ID/progress.jsonl"
"$SKILL_ROOT/scripts/node_modules/.bin/ts-node" "$SKILL_ROOT/assets/scaffold/orchestration/cli.ts" archive-start "{\"source\":\"run.sh\",\"project\":\"$PROJECT\",\"domain\":\"$DOMAIN\"}" 2>&1 | tail -1

# ─── 后台监控进度（每 5s 读取 progress.jsonl 并打印）───
_progress_poll() {
  local progress_file="$SANDBOX/artifacts/runs/$RUN_ID/progress.jsonl"
  local last_seq=-1
  while true; do
    if [[ -f "$progress_file" ]]; then
      local latest
      latest=$(tail -1 "$progress_file" 2>/dev/null | node -e "
        process.stdin.on('data',d=>{
          try{
            const l=JSON.parse(d.toString());
            if(l.caseId&&l.caseId!=='__run__'){
              const icon=l.status==='passed'?'✅':l.status==='failed'?'❌':l.status==='timeout'?'⏰':'⏳';
              process.stdout.write(icon+' ['+l.caseId+'] '+(l.desc||'')+(l.durationMs?' ('+l.durationMs+'ms)':''));
            }
          }catch(e){}
        })" 2>/dev/null)
      [[ -n "$latest" ]] && echo "  $latest"
    fi
    sleep 5
  done
}

# 启动后台进度轮询
_progress_poll &
PROGRESS_PID=$!

# 设置 wdio 超时兜底（单 spec 最长 90s, 最多等 30min）
WDIO_TIMEOUT=1800
if command -v gtimeout &>/dev/null; then
  gtimeout $WDIO_TIMEOUT npx wdio run wdio.conf.ts 2>&1 || STATUS=$?
elif command -v timeout &>/dev/null; then
  timeout $WDIO_TIMEOUT npx wdio run wdio.conf.ts 2>&1 || STATUS=$?
else
  # macOS: 没有 timeout 命令，用 perl 模拟
  perl -e "alarm $WDIO_TIMEOUT; exec @ARGV" -- npx wdio run wdio.conf.ts 2>&1 || STATUS=$?
fi

# 停止进度轮询
kill $PROGRESS_PID 2>/dev/null || true
wait $PROGRESS_PID 2>/dev/null || true

# 强制清理可能卡住的 wdio 进程
pkill -f "wdio run" 2>/dev/null || true

# 进度介质: 终态记录
if [[ $STATUS -eq 0 ]]; then
  echo '{"ts":'$(date +%s%3N)',"seq":999,"caseId":"__run__","status":"passed","desc":"Run completed"}' >> "$SANDBOX/artifacts/runs/$RUN_ID/progress.jsonl"
else
  echo '{"ts":'$(date +%s%3N)',"seq":999,"caseId":"__run__","status":"failed","desc":"Run completed with failures"}' >> "$SANDBOX/artifacts/runs/$RUN_ID/progress.jsonl"
fi

# ─── 8. 发布报告 ───
_generate_report() {
  echo ""
  echo "[init] 生成测试报告..."
  # 无论 wdio 是否正常退出，都尝试生成报告
  # 先生成 cases-executed.jsonl 若 wdio 未生成
  local executed_file="$SANDBOX/artifacts/runs/$RUN_ID/cases-executed.jsonl"
  if [[ ! -f "$executed_file" ]]; then
    # 从 progress.jsonl 和 wdio json reporter 重建
    local wdio_json="$SANDBOX/artifacts/runs/$RUN_ID/wdio-0-0-report.json"
    if [[ -f "$wdio_json" ]]; then
      echo "[init] 从 wdio json reporter 重建 cases-executed.jsonl"
      node -e "
        const r=require('$wdio_json');
        (r.specs||[]).forEach(s=>{
          (s.tests||[]).forEach(t=>{
            const line={caseId:s.filename?.match(/\\.(C\\d+)\\.spec/)?.[1]||'unknown',status:t.state,desc:t.title,durationMs:t.duration};
            console.log(JSON.stringify(line));
          });
        });" > "$executed_file" 2>/dev/null || true
    fi
  fi
  # 调用 publish-reports
  "$SKILL_ROOT/scripts/node_modules/.bin/ts-node" "$SKILL_ROOT/assets/scaffold/orchestration/cli.ts" publish-reports "$RUN_ID" 2>&1 | tail -5
  if [[ -d "$SANDBOX/reports" ]] && [[ "$(ls -A "$SANDBOX/reports" 2>/dev/null)" ]]; then
    echo "[init] 报告已发布到: $REPORTS_DIR/<task>/e2e-device/"
  fi
}

# 注册 trap：无论正常退出还是异常中断都生成报告 + 污染审计
trap '_generate_report; _audit_pollution' EXIT

# ─── 污染审计：检查沙箱可写目录是否意外 symlink 回 skill 源码 ───
_audit_pollution() {
  local leaked=0
  for dir in helpers config; do
    if [[ -L "$SANDBOX/$dir" ]]; then
      echo "[audit] ⚠️  $SANDBOX/$dir 是 symlink，存在污染风险！" >&2
      leaked=1
    fi
  done
  # 检查 skill 源码中是否有项目特定文件泄漏
  local skill_leaks
  skill_leaks=$(find "$SKILL_ROOT/assets/scaffold/helpers" "$SKILL_ROOT/assets/scaffold/config" \
    -maxdepth 1 -name "*.ts" -newer "$SKILL_ROOT/scripts/package.json" 2>/dev/null)
  if [[ -n "$skill_leaks" ]]; then
    echo "$skill_leaks" | while read -r f; do
      local bn; bn=$(basename "$f")
      # 白名单：框架已知文件不报警
      case "$bn" in
        adb.ts|android-config.ts|android-sdk.ts|android-vendor.ts|app-launcher.ts|auth-detect.ts|auth-recovery.ts|build-h5-url.ts|credentials.ts|deeplink.ts|device-bridge.ts|diagnostic-collector.ts|ensure-h5-nav-context.ts|logger.ts|login.ts|on-failure.ts|reset-session.ts|runtime-manifest.ts|session.ts|suite-entry.ts|types.ts|webview-context.ts|app.ts|env.ts|local-config.ts|platform.ts|project-manifest.ts|run-profile.ts|timeouts.ts) ;;
        *) echo "[audit]   LEAK: $f" >&2; leaked=1 ;;
      esac
    done
  fi
  [[ $leaked -eq 0 ]] && echo "[audit] 污染检查通过"
}

_generate_report

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
echo "  报告: $REPORTS_DIR/<task>/e2e-device/"
echo "  沙箱: $SANDBOX"
echo "═══════════════════════════════════════════════════════════════"

exit $STATUS
