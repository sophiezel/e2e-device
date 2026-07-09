#!/usr/bin/env bash
# e2e-device 统一入口 (Skill 级)
# 用法: bash ~/.agents/skills/e2e-device/scripts/run.sh --project <路径> --domain <domain> [--mode quick|resilience]
set -euo pipefail

SKILL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ─── 优雅关闭所有残留 Appium Session（防止 UiAutomator2 崩溃级联 adbd）───
_close_appium_sessions() {
  local port="${E2E_APPIUM_PORT:-4723}"
  if ! curl -s --connect-timeout 5 --max-time 10 "http://127.0.0.1:${port}/status" >/dev/null 2>&1; then
    return 0
  fi
  echo "[cleanup] 检查残留 Appium session..."
  local sessions
  sessions=$(curl -s --connect-timeout 5 --max-time 10 "http://127.0.0.1:${port}/wd/hub/sessions" 2>/dev/null | \
    python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  for s in d.get('value', []):
    print(s.get('id',''))
except: pass
" 2>/dev/null)
  if [[ -z "$sessions" ]]; then
    echo "[cleanup] 无残留 session"
    return 0
  fi
  echo "$sessions" | while read sid; do
    [[ -z "$sid" ]] && continue
    echo "[cleanup] 关闭 session: $sid"
    curl -s --connect-timeout 5 --max-time 10 -X DELETE "http://127.0.0.1:${port}/wd/hub/session/$sid" -o /dev/null 2>/dev/null
    sleep 1
  done
}

# ─── 重置 ADB 连接（清理 offline 状态, 不影响 TCP 连接）───
_reset_adb() {
  local devinfo
  devinfo=$(adb devices 2>/dev/null | grep -v "List of devices attached" | grep -v "^$")
  # 排除 TCP 设备（包含 :），只处理 USB offline
  local offline_usb
  offline_usb=$(echo "$devinfo" | grep "offline" | grep -v ":" | head -1 || true)
  if [[ -n "$offline_usb" ]]; then
    local serial
    serial=$(echo "$offline_usb" | awk '{print $1}')
    echo "[adb] USB 设备 offline: $serial, 尝试定向重置..."
    adb -s "$serial" reconnect 2>/dev/null || true
    sleep 3
    echo "[adb] ADB 已重置 ($serial)"
    # 重置后重新连接 TCP
    if [[ -f "${SANDBOX:-}/.tcp_addr" ]]; then
      local tcp_addr
      tcp_addr=$(cat "$SANDBOX/.tcp_addr" 2>/dev/null)
      if [[ -n "$tcp_addr" ]]; then
        sleep 2
        adb connect "$tcp_addr" 2>/dev/null || true
        sleep 2
      fi
    fi
  fi
}

# ─── 切换 ADB 到 TCP 模式（摆脱 USB 物理层依赖）───
_switch_to_tcp() {
  local tcp_port="${E2E_ADB_TCP_PORT:-5555}"
  local serial="${ANDROID_UDID:-${E2E_DEVICE_SERIAL:-}}"

  # 检查是否已经是 TCP 连接
  if [[ -n "$serial" ]] && echo "$serial" | grep -q ":"; then
    echo "[adb] 已经是 TCP 模式: $serial"
    return 0
  fi

  # 获取已连接的 USB 设备
  local usb_device
  usb_device=$(adb devices 2>/dev/null | grep -v "List" | grep -v "^$" | grep -v ":" | head -1 | awk '{print $1}')
  if [[ -z "$usb_device" ]]; then
    echo "[adb] ⚠️  无可用的 USB 设备, 跳过 TCP 切换"
    return 1
  fi

  echo "[adb] 切换 $usb_device 到 TCP 模式 (端口 $tcp_port)..."

  # 获取设备 IP（优先取 wlan0）
  local device_ip
  device_ip=$(adb -s "$usb_device" shell "ip -f inet addr show wlan0 2>/dev/null | grep inet | awk '{print \$2}' | cut -d/ -f1 | head -1" 2>/dev/null | tr -d '\r\n')
  if [[ -z "$device_ip" ]]; then
    device_ip=$(adb -s "$usb_device" shell "ifconfig wlan0 2>/dev/null | grep inet | awk '{print \$2}' | cut -d: -f2" 2>/dev/null | tr -d '\r\n')
  fi
  if [[ -z "$device_ip" ]]; then
    device_ip=$(adb -s "$usb_device" shell "getprop dhcp.wlan0.ipaddress" 2>/dev/null | tr -d '\r\n')
  fi

  if [[ -z "$device_ip" ]]; then
    echo "[adb] ⚠️  无法获取设备 IP，跳过 TCP 切换"
    return 1
  fi

  echo "[adb] 设备 IP: $device_ip"

  # 切换到 TCP 模式
  adb -s "$usb_device" tcpip "$tcp_port" 2>&1 || {
    echo "[adb] ⚠️  tcpip 切换失败，保持 USB 模式"
    return 1
  }

  # 等待设备 TCP 就绪
  sleep 3
  echo "[adb] 连接 $device_ip:$tcp_port..."
  adb connect "$device_ip:$tcp_port" 2>&1 || true
  sleep 2

  # 验证 TCP 连接
  if adb devices 2>/dev/null | grep "$device_ip:$tcp_port" | grep -q "device"; then
    echo "[adb] ✅ TCP 模式已就绪: $device_ip:$tcp_port"
    # 保存 USB 串号（Appium/UiAutomator2 需要 USB 串号, 不能传 TCP 地址）
    export ANDROID_UDID="$usb_device"
    export E2E_DEVICE_SERIAL="$usb_device"
    export E2E_USB_SERIAL="$usb_device"
    # 持久化 TCP 地址给看门狗和后续使用
    mkdir -p "${SANDBOX:-/tmp}" 2>/dev/null || true
    echo "$device_ip:$tcp_port" > "${SANDBOX:-/tmp}/.tcp_addr" 2>/dev/null || true
    echo "$usb_device" > "${SANDBOX:-/tmp}/.usb_serial" 2>/dev/null || true
    echo "[adb] 💡 现在可以拔掉 USB 线，ADB 将通过 TCP 通信（看门狗自动续连）"
  else
    echo "[adb] ⚠️  TCP 连接失败，保持 USB 模式"
    return 1
  fi
}

# ─── 屏幕常亮 + PIN 解锁（必须放最前面，保护后续耗时操作）───
_wake_device() {
  adb shell svc power stayon true 2>/dev/null || true
  adb shell settings put global stay_on_while_plugged_in 7 2>/dev/null || true
  adb shell input keyevent 224 2>/dev/null || true  # WAKEUP
  local pin="${E2E_DEVICE_PIN:-}"
  if [[ -n "$pin" ]] && [[ "$pin" =~ ^[0-9]+$ ]]; then
    for ((i=0; i<${#pin}; i++)); do
      adb shell input keyevent $((7 + ${pin:$i:1})) 2>/dev/null || true
    done
    adb shell input keyevent 66 2>/dev/null || true  # ENTER
  else
    adb shell input swipe 500 2000 500 500 2>/dev/null || true  # swipe to unlock
  fi
  adb shell input keyevent 3 2>/dev/null || true  # HOME
}

# ─── 默认值 ───
TCP_MODE=0
PROJECT=""
DOMAIN=""
MODE="standard"
CLEAN=0
PLAN_ONLY=0
AUTO_HEAL="${E2E_AUTO_HEAL:-1}"

_wake_device

# TCP 模式（需显式 --tcp 或 E2E_ADB_TCP=1；WiFi 环境不稳定时推荐 USB）
if [[ "$TCP_MODE" == "1" ]]; then
  _switch_to_tcp
fi

show_help() {
  cat <<EOF
e2e-device — Android USB Hybrid 真机 E2E

用法: bash $0 --project <项目路径> [选项]

选项:
  --project <path>   项目根路径 (必须)
  --domain <name>    domain 名称 (不指定则从 E2E_HOME 缓存自动探测)
  --mode <mode>      执行模式: quick(默认) | standard | resilience
  --tcp              启用 TCP 模式（WiFi ADB，摆脱 USB 线缆依赖）
  --plan-only        仅生成测试计划, 不执行
  --clean            执行后清理沙箱
  --help             帮助

示例:
  bash $0 --project /path/to/jian-h5
  bash $0 --project /path/to/jian-h5 --domain myFeature --mode resilience
  bash $0 --project /path/to/jian-h5 --tcp               # 启用 TCP 模式
EOF
  exit 0
}

# 解析参数
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --tcp) TCP_MODE=1; shift ;;
    --clean) CLEAN=1; shift ;;
    --plan-only) PLAN_ONLY=1; shift ;;
    --help|-h) show_help ;;
    *) echo "未知选项: $1" >&2; show_help ;;
  esac
done

# 校验
[[ -z "$PROJECT" ]] && { echo "错误: 需要 --project <项目路径>" >&2; exit 1; }
[[ ! -d "$PROJECT" ]] && { echo "错误: 项目路径不存在: $PROJECT" >&2; exit 1; }

# --domain 与 E2E_DOMAIN 对齐；禁止用 manifest 缓存静默兜底
if [[ -z "$DOMAIN" && -n "${E2E_DOMAIN:-}" ]]; then
  DOMAIN="$E2E_DOMAIN"
fi
if [[ -n "$DOMAIN" && -z "${E2E_DOMAIN:-}" ]]; then
  export E2E_DOMAIN="$DOMAIN"
fi

# 前置配置门禁：pageOrigin / appPackage / domain 必须经用户确认后由 env 注入
_missing=()
[[ -z "${E2E_PAGE_ORIGIN:-${E2E_H5_ORIGIN:-}}" ]] && _missing+=("E2E_PAGE_ORIGIN")
[[ -z "${E2E_APP_PACKAGE:-}" ]] && _missing+=("E2E_APP_PACKAGE")
[[ -z "${E2E_DOMAIN:-}" ]] && _missing+=("E2E_DOMAIN(--domain)")
if [[ ${#_missing[@]} -gt 0 ]]; then
  echo "[preflight] 错误: preconfig_unconfirmed — 缺少: ${_missing[*]}" >&2
  echo "[preflight] 请先自查候选并经用户确认后 export，再跑测:" >&2
  echo "  bash $SKILL_ROOT/scripts/list-preconfig.sh --project $PROJECT" >&2
  echo "  export E2E_PAGE_ORIGIN=<H5部署基址>" >&2
  echo "  export E2E_APP_PACKAGE=<测试包名>" >&2
  echo "  export E2E_DOMAIN=<主测domain>   # 或 --domain <name>" >&2
  exit 1
fi
# 规范化：统一使用 E2E_PAGE_ORIGIN
export E2E_PAGE_ORIGIN="${E2E_PAGE_ORIGIN:-$E2E_H5_ORIGIN}"
export E2E_H5_ORIGIN="${E2E_H5_ORIGIN:-$E2E_PAGE_ORIGIN}"
DOMAIN="${E2E_DOMAIN}"


RUN_ID="$(date +%Y%m%d-%H%M%S)-$((RANDOM % 1000))"
E2E_HOME="${E2E_HOME:-$HOME/.e2e-device}"
CACHE_DIR="$E2E_HOME/projects"
SHARED="$E2E_HOME/sandbox/shared"
PROJECT_HASH=$(echo -n "$PROJECT" | base64 | tr '/+=' '_' | cut -c1-32)
SANDBOX="$E2E_HOME/sandbox/$PROJECT_HASH/$DOMAIN"
LOGS_DIR="$E2E_HOME/logs"
GIT_BRANCH="$(git -C "$PROJECT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"
CACHE_JSON="$CACHE_DIR/${PROJECT_HASH}.json"
MANIFEST_JSON="$CACHE_DIR/${PROJECT_HASH}/manifest.json"
mkdir -p "$CACHE_DIR/${PROJECT_HASH}"

# ─── 从 manifest 读取 JSON 字段 ───
_json_field() {
  local file="$1" expr="$2"
  node -e "try{const j=require('$file');const v=($expr);process.stdout.write(v==null?'':String(v))}catch(e){}" 2>/dev/null
}

# ─── env 覆盖写回 manifest（含 userConfirmed 留痕）───
_merge_env_to_manifest() {
  [[ ! -f "$PROJECT_JSON" ]] && return 0
  node -e "
    const fs=require('fs');
    const p=process.argv[1];
    const envPage=(process.env.E2E_PAGE_ORIGIN||process.env.E2E_H5_ORIGIN||'').replace(/\/$/,'');
    const envPkg=process.env.E2E_APP_PACKAGE||'';
    const envDomain=process.env.E2E_DOMAIN||'';
    const j=JSON.parse(fs.readFileSync(p,'utf8'));
    let changed=false;
    j.hybrid=j.hybrid||{};
    j.hybrid.network=j.hybrid.network||{};
    j.hybrid.container=j.hybrid.container||{};
    j.pilot=j.pilot||{};
    if(envPage){
      const cur=(j.hybrid.network.pageOrigin||'').replace(/\/$/,'');
      if(cur!==envPage){ j.hybrid.network.pageOrigin=envPage; changed=true; console.log('[config] pageOrigin: '+cur+' → '+envPage); }
    }
    if(envPkg && j.hybrid.container.package!==envPkg){
      console.log('[config] appPackage: '+(j.hybrid.container.package||'(none)')+' → '+envPkg);
      j.hybrid.container.package=envPkg; changed=true;
    }
    if(envDomain && j.pilot.domain!==envDomain){
      console.log('[config] domain: '+(j.pilot.domain||'(none)')+' → '+envDomain);
      j.pilot.domain=envDomain; changed=true;
    }
    if(envPage && envPkg && envDomain){
      const prev=j.userConfirmed||{};
      const next={
        pageOrigin: envPage,
        appPackage: envPkg,
        domain: envDomain,
        confirmedAt: new Date().toISOString()
      };
      if(prev.pageOrigin!==next.pageOrigin || prev.appPackage!==next.appPackage || prev.domain!==next.domain){
        j.userConfirmed=next;
        changed=true;
        console.log('[config] userConfirmed 已写入 @ '+next.confirmedAt);
      } else if(!prev.confirmedAt){
        j.userConfirmed=next;
        changed=true;
      }
    }
    if(changed) fs.writeFileSync(p,JSON.stringify(j,null,2));
  " "$PROJECT_JSON" 2>/dev/null || true
}

# ─── 确保完整 manifest 存在 ───
_ensure_manifest() {
  if [[ -f "$MANIFEST_JSON" ]]; then
    local scheme
    scheme=$(_json_field "$MANIFEST_JSON" "j.hybrid?.deepLink?.scheme")
    if [[ -n "$scheme" ]]; then
      PROJECT_JSON="$MANIFEST_JSON"
      return 0
    fi
    echo "[init] manifest 不完整 (缺少 deepLink.scheme), 刷新 discover-project..."
  elif [[ -f "$CACHE_JSON" ]]; then
    echo "[init] 发现 legacy 缓存, 迁移到 manifest.json..."
  else
    echo "[init] 无项目缓存, 运行 discover-project..."
  fi

  E2E_PROJECT_ROOT="$PROJECT" \
    "$SKILL_ROOT/scripts/node_modules/.bin/ts-node" \
    "$SKILL_ROOT/assets/scaffold/orchestration/cli.ts" discover-project \
    > /dev/null 2>&1 || true

  if [[ -f "$MANIFEST_JSON" ]]; then
    PROJECT_JSON="$MANIFEST_JSON"
    return 0
  fi

  if [[ -f "$CACHE_JSON" ]]; then
    # discover 失败时复制 legacy → manifest 目录（仍可能不完整）
    cp "$CACHE_JSON" "$MANIFEST_JSON" 2>/dev/null || true
    PROJECT_JSON="$MANIFEST_JSON"
    return 0
  fi

  source "$SKILL_ROOT/scripts/probe-config.sh"
  probe_and_configure "$MANIFEST_JSON" "$PROJECT" "$DOMAIN"
  PROJECT_JSON="$MANIFEST_JSON"
}

_ensure_manifest

# probe 可能更新了 DOMAIN
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

# 合并 env 覆盖并导出运行时变量（禁止用 manifest 缓存兜底三元组）
_merge_env_to_manifest
PKG="${E2E_APP_PACKAGE}"
PAGE_ORIGIN="${E2E_PAGE_ORIGIN}"
DEEPLINK_SCHEME=$(_json_field "$PROJECT_JSON" "j.hybrid?.deepLink?.scheme")
CONFIRMED_AT=$(_json_field "$PROJECT_JSON" "j.userConfirmed?.confirmedAt")

export E2E_H5_ORIGIN="${E2E_H5_ORIGIN:-$E2E_PAGE_ORIGIN}"

echo "[preflight] effective 配置 (user-confirmed):"
echo "[preflight]   appPackage:  ${PKG}"
echo "[preflight]   pageOrigin:  ${PAGE_ORIGIN}"
echo "[preflight]   domain:      ${E2E_DOMAIN}"
echo "[preflight]   deepLink:    ${DEEPLINK_SCHEME:-未知}://openapi/openWebview?url=..."
[[ -n "$CONFIRMED_AT" ]] && echo "[preflight]   confirmedAt: $CONFIRMED_AT"

if [[ -z "$PKG" ]]; then
  echo "[preflight] 错误: preconfig_unconfirmed — E2E_APP_PACKAGE 未设置" >&2
  exit 1
fi
if [[ -z "$PAGE_ORIGIN" ]]; then
  echo "[preflight] 错误: preconfig_unconfirmed — E2E_PAGE_ORIGIN 未设置" >&2
  exit 1
fi
if [[ -z "$DEEPLINK_SCHEME" ]]; then
  echo "[preflight] 错误: deepLink.scheme 未配置 — 运行 discover-project 或检查 manifest" >&2
  echo "[preflight]   (该项通常需端上 adb dumpsys 确认，见 references/pre-config-items.md)" >&2
  exit 1
fi

# WebView debug 检查 (提示)
echo "[preflight] WebView debug: 需 App 编译时启用 setWebContentsDebuggingEnabled(true)"

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

# App 启动冒烟：scheme deeplink + -p 包名，验证前台包名
if [[ "${E2E_SKIP_APP_SMOKE:-}" != "1" ]]; then
  echo "[preflight] App 启动冒烟 (scheme deeplink + -p $PKG)..."
  SMOKE_H5_URL="${PAGE_ORIGIN}/"
  SMOKE_DEEPLINK=$(
    node -e "
      const scheme='${DEEPLINK_SCHEME}';
      const url=encodeURIComponent('${SMOKE_H5_URL}');
      console.log(scheme+'://openapi/openWebview?url='+url);
    " 2>/dev/null
  )
  adb shell am force-stop "$PKG" 2>/dev/null || true
  sleep 1
  if adb shell am start -a android.intent.action.VIEW -d "$SMOKE_DEEPLINK" -p "$PKG" >/dev/null 2>&1; then
    sleep 4
    FOCUS=$(
      {
        adb shell dumpsys window windows 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -1
        adb shell dumpsys activity activities 2>/dev/null | grep -E 'topResumedActivity|ResumedActivity' | head -1
      } | tr -d '\r' | head -1 || true
    )
    if echo "$FOCUS" | grep -q "$PKG"; then
      echo "[preflight] App 启动冒烟通过 ($PKG 在前台)"
    else
      # Fallback: newer Android (e.g. vivo) may omit mCurrentFocus
      RESUMED=$(adb shell dumpsys activity activities 2>/dev/null | tr -d '\r' | grep -E "topResumedActivity|ResumedActivity" | grep "$PKG" | head -1 || true)
      if [[ -n "$RESUMED" ]]; then
        echo "[preflight] App 启动冒烟通过 ($PKG 在前台, via activity dump)"
      else
        echo "[preflight] 错误: preflight_app_launch — 目标 App 未进入前台" >&2
        echo "[preflight]   期望包名: $PKG" >&2
        echo "[preflight]   当前焦点: ${FOCUS:-未知}" >&2
        echo "[preflight]   请确认 E2E_APP_PACKAGE 是否为测试包，且 App 已安装" >&2
        exit 1
      fi
    fi
  else
    echo "[preflight] 错误: preflight_app_launch — adb am start 失败" >&2
    echo "[preflight]   deeplink: $SMOKE_DEEPLINK" >&2
    exit 1
  fi
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
  "include": ["specs/**/*.ts", "wdio.conf.ts"]
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
  mkdir -p "$SANDBOX/$dir"
  # 每次运行同步框架文件（确保 skill 修复生效到已有 sandbox）
  if [[ -d "$src" ]]; then
    cp -a "$src/"* "$SANDBOX/$dir/" 2>/dev/null || true
    echo "[init] $dir: synced $(ls "$src" 2>/dev/null | wc -l | tr -d ' ') framework files"
  fi
}
_setup_writable_dir "helpers"
_setup_writable_dir "config"
_setup_writable_dir "chaos"

# ── 只读基础设施: symlink ──
ln -sfn "$SHARED/wdio.conf.ts" "$SANDBOX/wdio.conf.ts"
ln -sfn "$SHARED/tsconfig.json" "$SANDBOX/tsconfig.json"
ln -sfn "$PROJECT_JSON" "$SANDBOX/skill.project.json"

# 确保 sandbox 有 node_modules（指向 skill 的 @wdio 等依赖，避免 ts-node 编译失败）
if [[ ! -L "$SANDBOX/node_modules" ]] && [[ ! -d "$SANDBOX/node_modules" ]]; then
  # 优先用 scripts/node_modules（有 @wdio/types 等编译依赖）
  if [[ -d "$SKILL_ROOT/scripts/node_modules" ]]; then
    ln -sfn "$SKILL_ROOT/scripts/node_modules" "$SANDBOX/node_modules"
  elif [[ -d "$SKILL_ROOT/node_modules" ]]; then
    ln -sfn "$SKILL_ROOT/node_modules" "$SANDBOX/node_modules"
  fi
  echo "[init]   node_modules → symlink 到 Skill 依赖"
fi

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
DISCOVER_OUTPUT=$("$SKILL_ROOT/scripts/node_modules/.bin/ts-node" "$SKILL_ROOT/assets/scaffold/orchestration/cli.ts" discover-cases --union --domain "$DOMAIN" 2>&1) || true
echo "$DISCOVER_OUTPUT" | tail -10

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

# ─── 5.5 按 case-registry 过滤 sandbox specs（profile 过滤生效）───
if [[ -f "$SANDBOX/case-registry.json" ]]; then
  echo "[init] 按 profile 过滤 specs..."
  # 从 case-registry 提取允许的 spec 文件名
  KEPT_FILES=$(node -e "
    const r = require('$SANDBOX/case-registry.json');
    (r.cases || []).forEach(c => {
      const bn = require('path').basename(c.spec || '');
      if (bn && bn.endsWith('.spec.ts')) console.log(bn);
    });
  " 2>/dev/null)
  # 删除不在 filtered list 中的 spec
  REMOVED=0
  for f in "$SANDBOX/specs"/*.spec.ts; do
    [[ -f "$f" ]] || continue
    bn="$(basename "$f")"
    if ! echo "$KEPT_FILES" | grep -qxF "$bn"; then
      rm -f "$f"
      REMOVED=$((REMOVED + 1))
    fi
  done
  echo "[init] specs 过滤: 保留 $(echo "$KEPT_FILES" | wc -l | tr -d ' ') 个, 删除 $REMOVED 个"
fi

# ─── 6. 启动 Appium (如需要) ───
# 先清理残留 session + 重置 ADB（避免上次测试残留导致 UiAutomator2/adbd 崩溃）
_close_appium_sessions
_reset_adb

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

# ─── 报告生成函数（提前定义，供预检失败时调用）───
_generate_report() {
  echo ""
  echo "[init] 生成测试报告..."
  local executed_file="$SANDBOX/artifacts/runs/$RUN_ID/cases-executed.jsonl"
  if [[ ! -f "$executed_file" ]]; then
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
  "$SKILL_ROOT/scripts/node_modules/.bin/ts-node" "$SKILL_ROOT/assets/scaffold/orchestration/cli.ts" publish-reports "$RUN_ID" 2>&1 | tail -5
  if [[ -d "$SANDBOX/reports" ]] && [[ "$(ls -A "$SANDBOX/reports" 2>/dev/null)" ]]; then
    echo "[init] 报告已发布到: $REPORTS_DIR/<task>/e2e-device/"
  fi
}

# ─── 6.5 Spec 编译预检 ───
echo ""
echo "[preflight] Spec 编译预检..."
# 用 tsc --noEmit 一次性检查所有文件（不执行 describe/it，避免 Runtime ReferenceError）
TSC_OUTPUT=$(cd "$SANDBOX" && "$SKILL_ROOT/scripts/node_modules/.bin/tsc" --noEmit --project tsconfig.json 2>&1) || true

SPEC_TOTAL=$(ls "$SANDBOX/specs"/*.spec.ts 2>/dev/null | wc -l | tr -d ' ')
SPEC_FAIL_COUNT=0

for spec_file in "$SANDBOX/specs"/*.spec.ts; do
  [[ -f "$spec_file" ]] || continue
  spec_basename=$(basename "$spec_file")
  # 检查 tsc 输出中是否有当前文件的错误
  SPEC_ERRORS=$(echo "$TSC_OUTPUT" | grep "$spec_basename" 2>/dev/null || true)
  if [[ -n "$SPEC_ERRORS" ]]; then
    echo "  ❌ $spec_basename"
    echo "$SPEC_ERRORS" | head -2 | while read -r line; do echo "     $line"; done
    SPEC_FAIL_COUNT=$((SPEC_FAIL_COUNT + 1))
  else
    echo "  ✅ $spec_basename"
  fi
done

if [[ "$SPEC_FAIL_COUNT" -gt 0 ]]; then
  echo "[preflight] ⚠️  $SPEC_FAIL_COUNT/$SPEC_TOTAL 个 spec 编译失败"
  if [[ "$SPEC_FAIL_COUNT" -eq "$SPEC_TOTAL" ]]; then
    echo "[preflight] 🔴 所有 spec 编译失败，不进入执行阶段。请检查沙箱 helpers/config 依赖。"
    echo "[preflight] 沙箱路径: $SANDBOX"
    # 生成诊断事件
    echo '{"ts":'$(date +%s%3N)',"seq":0,"caseId":"__infra__","status":"infra_failure","desc":"All specs failed compilation"}' >> "$SANDBOX/artifacts/runs/$RUN_ID/progress.jsonl"
    _generate_report
    exit 5
  fi
else
  echo "[preflight] ✅ 全部 $SPEC_TOTAL 个 spec 编译通过"
fi

# ─── 7. 执行 ───
echo ""
echo "[init] 开始执行测试..."
STATUS=0

# 记录开始 + 触达进度介质 (progress.jsonl)
# 确保产物子目录存在
mkdir -p "$SANDBOX/artifacts/runs/$RUN_ID"/{screenshots,logs}
echo '{"ts":'$(date +%s%3N)',"seq":0,"caseId":"__run__","status":"running","desc":"Run started"}' >> "$SANDBOX/artifacts/runs/$RUN_ID/progress.jsonl"
"$SKILL_ROOT/scripts/node_modules/.bin/ts-node" "$SKILL_ROOT/assets/scaffold/orchestration/cli.ts" archive-start "{\"source\":\"run.sh\",\"project\":\"$PROJECT\",\"domain\":\"$DOMAIN\"}" 2>&1 | tail -1

# ─── TCP 连接看门狗（每 15s 检测 TCP 状态，断线自动续连）───
_tcp_watchdog() {
  local tcp_addr_file="$SANDBOX/.tcp_addr"
  while true; do
    sleep 15
    if [[ ! -f "$tcp_addr_file" ]]; then
      continue
    fi
    local tcp_addr
    tcp_addr=$(cat "$tcp_addr_file" 2>/dev/null | tr -d '\n\r')
    [[ -z "$tcp_addr" ]] && continue
    # 检查 TCP 设备状态
    local state
    state=$(adb devices 2>/dev/null | grep "$tcp_addr" | awk '{print $2}')
    if [[ "$state" != "device" ]]; then
      echo "[tcp-watchdog] ⚠️  TCP 断连 ($tcp_addr=$state), 尝试续连..."
      local retry=0
      while [[ $retry -lt 3 ]]; do
        adb connect "$tcp_addr" 2>/dev/null
        sleep 3
        state=$(adb devices 2>/dev/null | grep "$tcp_addr" | awk '{print $2}')
        if [[ "$state" == "device" ]]; then
          echo "[tcp-watchdog] ✅ TCP 续连成功 ($tcp_addr)"
          break
        fi
        retry=$((retry + 1))
        echo "[tcp-watchdog]   重试 $retry/3 失败, $((3 - retry)) 秒后再次尝试..."
      done
      if [[ "$state" != "device" ]]; then
        echo "[tcp-watchdog] ❌ TCP 续连失败, 请检查设备 WiFi 连接或重新插拔 USB"
      fi
    fi
  done
}

# ─── 后台监控进度（每 5s 读取 cases-executed.jsonl 并打印 ANSI 表格）───
_progress_poll() {
  local executed_file="$SANDBOX/artifacts/runs/$RUN_ID/cases-executed.jsonl"
  local last_count=-1
  local start_ts=$(date +%s)
  while true; do
    if [[ -f "$executed_file" ]]; then
      local current_count=$(wc -l < "$executed_file" 2>/dev/null | tr -d ' ')
      if [[ "$current_count" != "$last_count" ]]; then
        last_count=$current_count
        local now_ts=$(date +%s)
        local elapsed=$((now_ts - start_ts))
        local elapsed_str="${elapsed}s"
        if [[ $elapsed -ge 60 ]]; then
          elapsed_str="$((elapsed / 60))m$((elapsed % 60))s"
        fi
        # ANSI 清屏 + 光标归位
        printf '\033[2J\033[H'
        echo "══════════════════════════════════════════════════════════════"
        printf "  执行进度  |  RunID: %s  |  %s cases  |  总耗时: %s\n" "$RUN_ID" "$current_count" "$elapsed_str"
        echo "══════════════════════════════════════════════════════════════"
        # 读取并解析最后 N 行（最多显示 30 行）
        local tail_n=$((current_count < 30 ? current_count : 30))
        local passed=0 failed=0 timeout=0
        tail -"$tail_n" "$executed_file" 2>/dev/null | node -e "
          const lines = [];
          process.stdin.on('data', d => {
            d.toString().split('\n').filter(Boolean).forEach(line => {
              try {
                const r = JSON.parse(line);
                lines.push(r);
              } catch {}
            });
          });
          process.stdin.on('end', () => {
            lines.forEach((r, i) => {
              const num = String(lines.length - i).padStart(4);
              const icon = r.status === 'passed' ? '✅' : r.status === 'failed' ? '❌' : r.status === 'timeout' ? '⏱️' : '⏳';
              const name = (r.caseId || '').slice(0, 45);
              const dur = r.durationMs ? (r.durationMs / 1000).toFixed(1) + 's' : '—'.padEnd(4);
              process.stdout.write(num + ' ' + icon + ' ' + name.padEnd(45) + ' ' + dur.padStart(6) + '\n');
            });
          });
        "
        # 统计行
        passed=$(grep -c '"status":"passed"' "$executed_file" 2>/dev/null || echo 0)
        failed=$(grep -c '"status":"failed"' "$executed_file" 2>/dev/null || echo 0)
        timeout=$(grep -c '"status":"timeout"' "$executed_file" 2>/dev/null || echo 0)
        echo "──────────────────────────────────────────────────────────────"
        printf "  通过: %-4s  失败: %-4s  超时: %-4s  总耗时: %s\n" "$passed" "$failed" "$timeout" "$elapsed_str"
        echo ""
      fi
    fi
    sleep 5
  done
}

# 启动后台进程
WATCHDOG_PID=""
_progress_poll &
PROGRESS_PID=$!

# 启动 TCP 看门狗（TCP 模式下自动续连）
if [[ -f "$SANDBOX/.tcp_addr" ]]; then
  _tcp_watchdog &
  WATCHDOG_PID=$!
  echo "[init] TCP 看门狗已启动（每 15s 心跳检测）"
fi



# 设置 wdio 超时兜底（单 spec 最长 90s, 最多等 30min）
WDIO_TIMEOUT=600
# 捕获完整 wdio 输出到临时日志文件（诊断用）
if command -v gtimeout &>/dev/null; then
  gtimeout $WDIO_TIMEOUT npx wdio run wdio.conf.ts 2>&1 | tee /tmp/wdio-output-$$.log || STATUS=$?
elif command -v timeout &>/dev/null; then
  timeout $WDIO_TIMEOUT npx wdio run wdio.conf.ts 2>&1 | tee /tmp/wdio-output-$$.log || STATUS=$?
else
  # macOS: 没有 timeout 命令，用 perl 模拟
  perl -e "alarm $WDIO_TIMEOUT; exec @ARGV" -- npx wdio run wdio.conf.ts 2>&1 | tee /tmp/wdio-output-$$.log || STATUS=$?
fi

# 停止进度轮询
kill $PROGRESS_PID 2>/dev/null || true
wait $PROGRESS_PID 2>/dev/null || true
[[ -n "$WATCHDOG_PID" ]] && kill $WATCHDOG_PID 2>/dev/null || true
[[ -n "$WATCHDOG_PID" ]] && wait $WATCHDOG_PID 2>/dev/null || true

# 先优雅关闭 Appium session（防止强杀 UiAutomator2 → adbd offline）
_close_appium_sessions

# 再强制清理可能卡住的 wdio 进程
pkill -f "wdio run" 2>/dev/null || true

# ── 写 wdio 输出到日志（用于诊断）───
mkdir -p "$SANDBOX/artifacts/runs/$RUN_ID/logs"
if [[ -f /tmp/wdio-output-$$.log ]]; then
  cp /tmp/wdio-output-$$.log "$SANDBOX/artifacts/runs/$RUN_ID/logs/wdio-output.log" 2>/dev/null || true
  rm -f /tmp/wdio-output-$$.log 2>/dev/null || true
fi

# 进度介质: 终态记录
if [[ $STATUS -eq 0 ]]; then
  echo '{"ts":'$(date +%s%3N)',"seq":999,"caseId":"__run__","status":"passed","desc":"Run completed"}' >> "$SANDBOX/artifacts/runs/$RUN_ID/progress.jsonl"
else
  echo '{"ts":'$(date +%s%3N)',"seq":999,"caseId":"__run__","status":"failed","desc":"Run completed with failures","exitCode":'$STATUS'}' >> "$SANDBOX/artifacts/runs/$RUN_ID/progress.jsonl"
fi

# 注册 trap：清理后台进程 + 生成报告 + 污染审计
trap 'kill $PROGRESS_PID 2>/dev/null || true; [[ -n "$WATCHDOG_PID" ]] && kill $WATCHDOG_PID 2>/dev/null || true; _generate_report; _audit_pollution' EXIT

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

# 重置 ADB 连接（避免残留 offline 状态）
_reset_adb

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
if [[ -f "$SANDBOX/.tcp_addr" ]]; then
  tcp_addr=$(cat "$SANDBOX/.tcp_addr" 2>/dev/null)
  if [[ -n "$tcp_addr" ]]; then
    echo "  ADB:   TCP $tcp_addr (看门狗已停止, 连接保留)"
    echo "  下次执行自动复用 TCP 连接"
  fi
fi
echo "═══════════════════════════════════════════════════════════════"

exit $STATUS
