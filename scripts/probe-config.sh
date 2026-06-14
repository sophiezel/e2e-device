#!/usr/bin/env bash
# 首次运行配置引导
# 前置条件: discover-project 已探测, 隔离写入缓存
# 交互确认: pageOrigin (必需), domain (必需)

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

  # ── Step 2: pageOrigin (必需) ──
  local page_origin
  page_origin=$(json_get "hybrid?.network?.pageOrigin")
  # 非交互模式优先使用 E2E_PAGE_ORIGIN 环境变量
  [[ -z "$page_origin" ]] && page_origin="${E2E_PAGE_ORIGIN:-}"
  [[ -z "$page_origin" ]] && page_origin="${E2E_H5_ORIGIN:-}"
  
  if [[ $interactive -eq 0 ]]; then
    # Agent/自动化模式：静默使用探测值或环境变量，不阻塞
    if [[ -n "$page_origin" ]]; then
      echo "[probe] pageOrigin: $page_origin (自动确认)"
    else
      echo "[probe] 未探测到 pageOrigin，请设置 E2E_PAGE_ORIGIN 环境变量"
      return 1
    fi
  else
    if [[ -z "$page_origin" ]]; then
      echo "[probe] 未探测到 pageOrigin (H5 部署域名)"
      while [[ $interactive -eq 1 ]] && [[ -z "$page_origin" ]]; do
        _safe_read page_origin "  请输入 pageOrigin: "
      done
      # 非交互回退
      [[ -z "$page_origin" ]] && page_origin="${E2E_PAGE_ORIGIN:-}"
    else
      echo "[probe] 探测到 pageOrigin: $page_origin"
      _safe_read input "  确认使用? [Enter=确认 / 输入新值]: " || true
      [[ -n "$input" ]] && page_origin="$input"
    fi
  fi
  echo ""

  # ── Step 3: domain (必需) ──
  local domain="$preset_domain"
  
  if [[ $interactive -eq 0 ]]; then
    # Agent/自动化模式：优先 --domain > E2E_DOMAIN > 探测值
    [[ -z "$domain" ]] && domain="${E2E_DOMAIN:-}"
    [[ -z "$domain" ]] && domain=$(json_get "pilot?.domain")
    [[ -z "$domain" ]] && domain=$(json_get "lastDomain")
    if [[ -n "$domain" ]]; then
      echo "[probe] domain: $domain (自动确认)"
    else
      # 兜底：用项目名推导
      domain=$(basename "$project" | tr '-' '_')
      echo "[probe] domain: $domain (从项目名推导)"
    fi
  else
    if [[ -n "$domain" ]]; then
      echo "[probe] domain 已通过 --domain 指定: $domain"
    else
      domain=$(json_get "pilot?.domain")

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

      # 仍未获取到 → 回退
      if [[ $interactive -eq 1 ]]; then
        while [[ -z "$domain" ]]; do
          _safe_read domain "  请输入 domain: " || { interactive=0; domain="${E2E_DOMAIN:-$(basename "$project" | tr '-' '_')}"; break; }
        done
      else
        domain="${E2E_DOMAIN:-$(basename "$project" | tr '-' '_')}"
        echo "[probe] domain: $domain (自动推导)"
      fi
    fi
  fi
  fi  # end interactive/else
  echo ""

  # ── Step 4: appPackage (自动探测 + 多App引导) ──
  local app_package
  app_package=$(json_get "hybrid?.container?.package")
  
  # 如果 discover-project 未探测到包名, 通过 adb 自动匹配
  if [[ -z "$app_package" ]]; then
    echo "[probe] 未探测到包名, 正在通过 adb 自动匹配..."
    # 从项目 package.json 提取关键词用于匹配
    local proj_name
    proj_name=$(node -e "try{console.log(require('$project/package.json').name||'')}catch(e){}" 2>/dev/null)
    # 从设备获取所有第三方包
    local pkgs
    pkgs=$(adb shell "pm list packages -3" 2>/dev/null | tr -d '\r' | sed 's/package://g')
    
    # 尝试匹配: 从项目名提取关键词
    local proj_keyword
    proj_keyword=$(echo "$proj_name" | grep -oE '[a-z]+' | head -1)
    local -a matches=()
    while IFS= read -r pkg; do
      [[ -z "$pkg" ]] && continue
      if [[ -n "$proj_keyword" ]] && echo "$pkg" | grep -qi "$proj_keyword"; then
        matches+=("$pkg")
      fi
    done <<< "$pkgs"
    
    # 如果没匹配到, 列出全部第三方包供用户选择
    if [[ ${#matches[@]} -eq 0 ]]; then
      echo "[probe] 未匹配到, 设备上所有第三方 App:"
      local all_pkgs=()
      while IFS= read -r p; do [[ -n "$p" ]] && all_pkgs+=("$p"); done <<< "$pkgs"
      for i in "${!all_pkgs[@]}"; do
        echo "  $((i+1)). ${all_pkgs[$i]}"
      done
      echo -n "  输入编号选择, 或直接输入包名: "
      _safe_read choice || true
      if [[ "$choice" =~ ^[0-9]+$ ]] && [[ "$choice" -le "${#all_pkgs[@]}" ]]; then
        app_package="${all_pkgs[$((choice-1))]}"
      else
        app_package="$choice"
      fi
    elif [[ ${#matches[@]} -gt 1 ]]; then
      echo "[probe] 匹配到多个候选 App:"
      for i in "${!matches[@]}"; do
        echo "  $((i+1)). ${matches[$i]}"
      done
      _safe_read choice "  输入编号选择: " || true
      if [[ "$choice" =~ ^[0-9]+$ ]] && [[ "$choice" -le "${#matches[@]}" ]]; then
        app_package="${matches[$((choice-1))]}"
      fi
    elif [[ ${#matches[@]} -eq 1 ]]; then
      app_package="${matches[0]}"
      echo "[probe] 自动匹配到 App: $app_package"
    fi
    
    if [[ -z "$app_package" ]]; then
      if [[ $interactive -eq 1 ]]; then
        _safe_read app_package "  请输入包名 (如 com.example.app): " || true
      fi
      # 非交互回退：尝试通过 discover-project 自动探测
      [[ -z "$app_package" ]] && app_package="unknown"
    fi
  fi

  # ── Step 5: 写入缓存 ──
  cat > "$cache_json" <<EOF
{
  "id": "$(basename "$project")",
  "pilot": { "domain": "$domain" },
  "hybrid": {
    "platform": "android",
    "container": { "package": "${app_package}" },
    "network": {
      "pageOrigin": "${page_origin}"
    }
  }
}
EOF
  echo "[probe] 配置已保存: $cache_json"
  PROJECT_JSON="$cache_json"
  DOMAIN="$domain"
}
