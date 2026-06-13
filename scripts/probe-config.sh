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
  
  if [[ -z "$page_origin" ]]; then
    echo "[probe] 未探测到 pageOrigin (H5 部署域名)"
    while [[ -z "$page_origin" ]]; do
      echo -n "  请输入 pageOrigin: "
      read -r page_origin
    done
  else
    echo "[probe] 探测到 pageOrigin: $page_origin"
    echo -n "  确认使用? [Enter=确认 / 输入新值]: "
    read -r input
    [[ -n "$input" ]] && page_origin="$input"
  fi
  echo ""

  # ── Step 3: domain (必需) ──
  local domain="$preset_domain"
  
  if [[ -n "$domain" ]]; then
    echo "[probe] domain 已通过 --domain 指定: $domain"
  else
    domain=$(json_get "pilot?.domain")

    if [[ -n "$domain" ]]; then
      # 探测到 1 个 → 确认
      echo "[probe] 探测到 domain: $domain"
      echo -n "  确认使用? [Enter=确认 / 输入新值]: "
      read -r input
      [[ -n "$input" ]] && domain="$input"
    else
      # 探测到 0 个 → 尝试从路由列表展示
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
        echo -n "  输入编号选择, 或直接输入 domain: "
        read -r input
        if [[ "$input" =~ ^[0-9]+$ ]] && [[ "$input" -le "${#routes[@]}" ]]; then
          domain="${routes[$((input-1))]}"
        else
          domain="$input"
        fi
      fi

      # 仍未获取到 → 直接输入
      while [[ -z "$domain" ]]; do
        echo -n "  请输入 domain: "
        read -r domain
      done
    fi
  fi
  echo ""

  # ── Step 4: appPackage (自动, 无需交互) ──
  local app_package
  app_package=$(json_get "hybrid?.container?.package")

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
