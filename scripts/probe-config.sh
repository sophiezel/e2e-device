#!/usr/bin/env bash
# 首次运行配置引导
# 前置条件: discover-project 已探测, 隔离写入缓存
# 交互确认: pageOrigin / domain / appPackage（非交互必须由 E2E_* env 注入，禁止静默自动确认）

probe_and_configure() {
  local cache_json="$1"
  local project="$2"
  local preset_domain="${3:-}"

  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  首次使用 — 项目配置引导"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""

  mkdir -p "$(dirname "$cache_json")"

  # 检测是否为交互式终端（无 tty = Agent/自动化模式，跳过 read -r）
  # 三层防护：1) stdin 是 tty  2) 非 CI  3) 未显式禁用交互
  local interactive=1
  [[ -t 0 ]] || interactive=0
  [[ -n "${CI:-}" ]] && interactive=0
  [[ "${E2E_NON_INTERACTIVE:-}" == "1" ]] && interactive=0
  
  # read 超时兜底（秒），防止 stdin 是伪 tty 但无法接收输入
  local READ_TIMEOUT=5
  
  # 安全 read：超时或失败则返回空并标记非交互
  _safe_read() {
    local var_name="$1"
    local prompt="$2"
    if [[ $interactive -eq 0 ]]; then
      eval "$var_name=''"
      return 1
    fi
    echo -n "$prompt"
    if read -t "$READ_TIMEOUT" -r "$var_name" 2>/dev/null; then
      return 0
    else
      echo "(超时/输入不可用，切换为非交互模式)"
      interactive=0
      eval "$var_name=''"
      return 1
    fi
  }

  _print_preconfig_hint() {
    echo "[probe] blocker: preconfig_unconfirmed" >&2
    echo "[probe] 请先运行: bash \$SKILL_ROOT/scripts/list-preconfig.sh --project $project" >&2
    echo "[probe] Agent AskQuestion 确认后 export:" >&2
    echo "  export E2E_PAGE_ORIGIN=<H5部署基址>" >&2
    echo "  export E2E_APP_PACKAGE=<测试包名>" >&2
    echo "  export E2E_DOMAIN=<主测domain>" >&2
  }

  # ── Step 1: 运行 discover-project (临时沙箱, 不碰项目) ──
  echo "[probe] 正在探测项目结构..."
  local probe_sb="$E2E_HOME/.probe-$$"
  mkdir -p "$probe_sb"
  E2E_PROJECT_ROOT="$project" E2E_SANDBOX="$probe_sb" \
    "$SKILL_ROOT/scripts/node_modules/.bin/ts-node" "$SKILL_ROOT/assets/scaffold/orchestration/cli.ts" discover-project \
    > /dev/null 2>&1 || true

  # discover-project 通过 projectJsonWrite 写入缓存
  local detected_json
  if [[ -f "$cache_json" ]]; then
    detected_json=$(node -e "console.log(JSON.stringify(require('$cache_json')))" 2>/dev/null || echo '{}')
  else
    detected_json='{}'
  fi
  rm -rf "$probe_sb"

  # ── 辅助函数: 从 JSON 提取字段 ──
  json_get() {
    echo "$detected_json" | node -e "process.stdin.on('data',d=>{try{const j=JSON.parse(d);console.log(eval('j.'+'$1')||'')}catch(e){}})" 2>/dev/null
  }

  # ── Step 2: pageOrigin (必需；非交互仅接受 E2E_* env) ──
  local page_origin=""
  local detected_page
  detected_page=$(json_get "hybrid?.network?.pageOrigin")

  if [[ $interactive -eq 0 ]]; then
    page_origin="${E2E_PAGE_ORIGIN:-${E2E_H5_ORIGIN:-}}"
    if [[ -z "$page_origin" ]]; then
      echo "[probe] 错误: 非交互模式禁止自动确认 pageOrigin" >&2
      if [[ -n "$detected_page" ]]; then
        echo "[probe] 探测建议值(未确认): $detected_page" >&2
      fi
      _print_preconfig_hint
      return 1
    fi
    echo "[probe] pageOrigin: $page_origin (来自 E2E_PAGE_ORIGIN/E2E_H5_ORIGIN)"
  else
    page_origin="${E2E_PAGE_ORIGIN:-${E2E_H5_ORIGIN:-$detected_page}}"
    if [[ -z "$page_origin" ]]; then
      echo "[probe] 未探测到 pageOrigin (H5 部署域名)"
      while [[ $interactive -eq 1 ]] && [[ -z "$page_origin" ]]; do
        _safe_read page_origin "  请输入 pageOrigin: "
      done
      [[ -z "$page_origin" ]] && page_origin="${E2E_PAGE_ORIGIN:-}"
    else
      echo "[probe] 探测到 pageOrigin: $page_origin"
      _safe_read input "  确认使用? [Enter=确认 / 输入新值]: " || true
      [[ -n "$input" ]] && page_origin="$input"
    fi
    if [[ -z "$page_origin" ]]; then
      echo "[probe] 错误: pageOrigin 未确认" >&2
      _print_preconfig_hint
      return 1
    fi
  fi
  echo ""

  # ── Step 3: domain (必需；非交互仅接受 --domain / E2E_DOMAIN) ──
  local domain="$preset_domain"
  
  if [[ $interactive -eq 0 ]]; then
    [[ -z "$domain" ]] && domain="${E2E_DOMAIN:-}"
    if [[ -z "$domain" ]]; then
      echo "[probe] 错误: 非交互模式禁止自动确认 domain" >&2
      local suggested
      suggested=$(json_get "pilot?.domain")
      [[ -n "$suggested" ]] && echo "[probe] 探测建议值(未确认): $suggested" >&2
      _print_preconfig_hint
      return 1
    fi
    echo "[probe] domain: $domain (来自 --domain / E2E_DOMAIN)"
  else
    if [[ -n "$domain" ]]; then
      echo "[probe] domain 已通过 --domain 指定: $domain"
      _safe_read input "  确认使用? [Enter=确认 / 输入新值]: " || true
      [[ -n "$input" ]] && domain="$input"
    else
      domain="${E2E_DOMAIN:-$(json_get "pilot?.domain")}"

      if [[ -n "$domain" ]]; then
        echo "[probe] 探测到 domain: $domain"
        _safe_read input "  确认使用? [Enter=确认 / 输入新值]: " || true
        [[ -n "$input" ]] && domain="$input"
      else
        local routes_json
        routes_json=$(json_get "pilot?.routes" | node -e "
          process.stdin.on('data',d=>{
            try{const r=JSON.parse(d);console.log(Object.keys(r).join(','))}catch(e){}
          })" 2>/dev/null)
        
        if [[ -n "$routes_json" ]]; then
          echo "[probe] 探测到以下可用 domain:"
          IFS=',' read -ra routes <<< "$routes_json"
          for i in "${!routes[@]}"; do
            echo "  $((i+1)). ${routes[$i]}"
          done
          _safe_read input "  输入编号选择, 或直接输入 domain: " || true
          if [[ "$input" =~ ^[0-9]+$ ]] && [[ "$input" -le "${#routes[@]}" ]]; then
            domain="${routes[$((input-1))]}"
          else
            domain="$input"
          fi
        fi

        if [[ $interactive -eq 1 ]]; then
          while [[ -z "$domain" ]]; do
            _safe_read domain "  请输入 domain: " || { interactive=0; break; }
          done
        fi
      fi
    fi
    if [[ -z "$domain" ]]; then
      echo "[probe] 错误: domain 未确认" >&2
      _print_preconfig_hint
      return 1
    fi
  fi
  echo ""

  # ── Step 4: appPackage (非交互必须 E2E_APP_PACKAGE；禁止静默自动匹配) ──
  local app_package=""
  [[ -n "${E2E_APP_PACKAGE:-}" ]] && app_package="$E2E_APP_PACKAGE"

  # 收集设备候选包（guazi/jian/项目关键词）
  _collect_app_candidates() {
    local proj_name="$1"
    local pkgs
    pkgs=$(adb shell "pm list packages -3" 2>/dev/null | tr -d '\r' | sed 's/package://g')
    local proj_keyword
    proj_keyword=$(echo "$proj_name" | grep -oE '[a-z]+' | head -1)
    local -a matches=()
    while IFS= read -r pkg; do
      [[ -z "$pkg" ]] && continue
      if echo "$pkg" | grep -qiE 'guazi|jian'; then
        matches+=("$pkg")
      elif [[ -n "$proj_keyword" ]] && echo "$pkg" | grep -qi "$proj_keyword"; then
        matches+=("$pkg")
      fi
    done <<< "$pkgs"
    # 去重
    local -a unique=()
    local p u found
    for p in "${matches[@]}"; do
      found=0
      for u in "${unique[@]}"; do [[ "$u" == "$p" ]] && found=1 && break; done
      [[ $found -eq 0 ]] && unique+=("$p")
    done
    printf '%s\n' "${unique[@]}"
  }

  if [[ -z "$app_package" ]]; then
    local detected_pkg
    detected_pkg=$(json_get "hybrid?.container?.package")
    echo "[probe] 未设置 E2E_APP_PACKAGE, 正在通过 adb 列出 guazi/jian 相关 App..."
    local proj_name
    proj_name=$(node -e "try{console.log(require('$project/package.json').name||'')}catch(e){}" 2>/dev/null)
    local -a matches=()
    while IFS= read -r line; do [[ -n "$line" ]] && matches+=("$line"); done < <(_collect_app_candidates "$proj_name")

    if [[ ${#matches[@]} -eq 0 ]]; then
      echo "[probe] 未匹配到 guazi/jian 相关包, 设备上所有第三方 App:"
      local all_pkgs=()
      local pkgs_raw
      pkgs_raw=$(adb shell "pm list packages -3" 2>/dev/null | tr -d '\r' | sed 's/package://g')
      while IFS= read -r p; do [[ -n "$p" ]] && all_pkgs+=("$p"); done <<< "$pkgs_raw"
      for i in "${!all_pkgs[@]}"; do
        echo "  $((i+1)). ${all_pkgs[$i]}"
      done
      if [[ $interactive -eq 0 ]]; then
        echo "[probe] 错误: 非交互模式未设置 E2E_APP_PACKAGE" >&2
        [[ -n "$detected_pkg" ]] && echo "[probe] 探测建议值(未确认): $detected_pkg" >&2
        _print_preconfig_hint
        return 1
      fi
      _safe_read choice "  输入编号选择, 或直接输入包名: " || true
      if [[ "$choice" =~ ^[0-9]+$ ]] && [[ "$choice" -le "${#all_pkgs[@]}" ]]; then
        app_package="${all_pkgs[$((choice-1))]}"
      else
        app_package="$choice"
      fi
    elif [[ ${#matches[@]} -gt 1 ]]; then
      echo "[probe] 匹配到多个候选 App (正式包/测试包需确认):"
      for i in "${!matches[@]}"; do
        local dbg=""
        if adb shell dumpsys package "${matches[$i]}" 2>/dev/null | grep -q 'DEBUGGABLE'; then
          dbg=" [debuggable]"
        fi
        echo "  $((i+1)). ${matches[$i]}${dbg}"
      done
      if [[ $interactive -eq 0 ]]; then
        echo "[probe] 错误: 非交互模式检测到 ${#matches[@]} 个候选 App — 请设置 E2E_APP_PACKAGE=<测试包名>" >&2
        for i in "${!matches[@]}"; do echo "  $((i+1)). ${matches[$i]}" >&2; done
        _print_preconfig_hint
        return 1
      fi
      _safe_read choice "  输入编号选择测试包: " || true
      if [[ "$choice" =~ ^[0-9]+$ ]] && [[ "$choice" -le "${#matches[@]}" ]]; then
        app_package="${matches[$((choice-1))]}"
      else
        app_package="$choice"
      fi
    elif [[ ${#matches[@]} -eq 1 ]]; then
      app_package="${matches[0]}"
      if [[ $interactive -eq 1 ]]; then
        echo "[probe] 自动匹配到 App: $app_package"
        _safe_read input "  确认使用? [Enter=确认 / 输入新包名]: " || true
        [[ -n "$input" ]] && app_package="$input"
      else
        # 非交互：即使只有 1 个候选也禁止静默确认
        echo "[probe] 错误: 非交互模式禁止自动确认 appPackage ($app_package)" >&2
        echo "[probe] 请 export E2E_APP_PACKAGE=$app_package 后重试" >&2
        _print_preconfig_hint
        return 1
      fi
    fi

    if [[ -z "$app_package" ]]; then
      if [[ $interactive -eq 1 ]]; then
        _safe_read app_package "  请输入包名 (如 com.example.app): " || true
      fi
    fi
  else
    echo "[probe] appPackage: $app_package (来自 E2E_APP_PACKAGE)"
  fi

  if [[ -z "$app_package" || "$app_package" == "unknown" ]]; then
    echo "[probe] 错误: appPackage 未确认" >&2
    _print_preconfig_hint
    return 1
  fi

  # ── Step 5: merge 写入 manifest.json（保留 discover 完整字段 + userConfirmed）───
  mkdir -p "$(dirname "$cache_json")"
  node -e "
    const fs=require('fs');
    const path=require('path');
    const dest=process.argv[1];
    const domain=process.argv[2];
    const pageOrigin=process.argv[3];
    const appPackage=process.argv[4];
    const projectId=process.argv[5];
    let j={};
    if(fs.existsSync(dest)){
      try{ j=JSON.parse(fs.readFileSync(dest,'utf8')); }catch(e){}
    }
    j.id=j.id||projectId;
    j.pilot=j.pilot||{};
    j.pilot.domain=domain;
    j.hybrid=j.hybrid||{};
    j.hybrid.platform=j.hybrid.platform||'android';
    j.hybrid.container=j.hybrid.container||{};
    j.hybrid.container.package=appPackage;
    j.hybrid.network=j.hybrid.network||{};
    j.hybrid.network.pageOrigin=pageOrigin;
    j.hybrid.deepLink=j.hybrid.deepLink||{
      scheme:'', openPath:'openapi', h5Action:'openWebview',
      requiredQuery:['url'], forbiddenQueryOnColdOpen:['token']
    };
    j.userConfirmed={
      pageOrigin,
      appPackage,
      domain,
      confirmedAt: new Date().toISOString()
    };
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.writeFileSync(dest,JSON.stringify(j,null,2));
    console.log('[probe] 配置已 merge 到: '+dest);
  " "$cache_json" "$domain" "$page_origin" "$app_package" "$(basename "$project")"

  PROJECT_JSON="$cache_json"
  DOMAIN="$domain"
}
