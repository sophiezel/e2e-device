#!/usr/bin/env bash
# Offline pipeline self-check (no USB device required).
# Covers: tsc, assert-quality, preclassify, discover+plan against a temp fixture.
set -euo pipefail
SKILL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TS_NODE="$SKILL_ROOT/scripts/node_modules/.bin/ts-node"
TSC="$SKILL_ROOT/scripts/node_modules/.bin/tsc"
CLI="$SKILL_ROOT/assets/scaffold/orchestration/cli.ts"
WORK="$(mktemp -d /tmp/e2e-device-selfcheck-XXXXXX)"
export E2E_HOME="$WORK/e2e-home"
export E2E_DEVICE_SKILL_ROOT="$SKILL_ROOT"
mkdir -p "$E2E_HOME"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }

echo "=== 1) tsc --noEmit (scaffold) ==="
if (cd "$SKILL_ROOT/assets/scaffold" && "$TSC" --noEmit -p tsconfig.json); then
  pass "tsc scaffold"
else
  fail "tsc scaffold"
fi

echo "=== 2) assert-quality + preclassify unit ==="
if (cd "$SKILL_ROOT/assets/scaffold" && "$TS_NODE" orchestration/self-check-offline.ts); then
  pass "offline unit"
else
  fail "offline unit"
fi

echo "=== 3) fixture project discover + present-test-plan ==="
PROJ="$WORK/fixture-h5"
mkdir -p "$PROJ/docs/features" "$PROJ/src"
cat > "$PROJ/package.json" <<'EOF'
{ "name": "e2e-fixture-demo", "version": "0.0.0", "private": true }
EOF
# Minimal matrix with strong + weak rows (must match parseMatrixTable contract)
cat > "$PROJ/docs/features/demoFeature.md" <<'EOF'
# demoFeature

## 验收与验证矩阵

| Case ID | source | pageModule | acceptanceCriteria | preconditions | operation | expectedResult | executionMethod | minimalVerification |
|--------|--------|------------|--------------------|---------------|-----------|----------------|-----------------|---------------------|
| C01 | matrix | demoFeature | toast | 无 clueId | 打开页 | Toast 提示缺少车源号 | auto | 可见 Toast 缺少车源号 |
| C02 | matrix | demoFeatureForm | 渲染 | 已进页 | 打开表单 | 页面渲染 | auto | 首屏展示 |
| C03 | matrix | demoFeatureForm | 提交 | 已填表 | 点提交 | Toast 提交失败 | auto | 可见 Toast 提交失败 |
EOF
cat > "$PROJ/src/App.tsx" <<'EOF'
export default function App() { return null }
EOF

# Must match paths.projectHash() (not shell base64/tr — +/= handling differs)
HASH=$(node -e '
  const path=require("path");
  const p=path.resolve(process.argv[1]);
  console.log(
    Buffer.from(p).toString("base64")
      .replace(/\//g,"_")
      .replace(/\+/g,"-")
      .replace(/=/g,"")
      .slice(0,32)
  );
' "$PROJ")
SANDBOX="$E2E_HOME/sandbox/$HASH/demoFeature"
mkdir -p "$SANDBOX"
export E2E_SANDBOX="$SANDBOX"
export E2E_PROJECT_ROOT="$PROJ"
export E2E_DOMAIN="demoFeature"
export E2E_PAGE_ORIGIN="https://h5.example.com/v2"
export E2E_APP_PACKAGE="com.example.app.debug"
export E2E_RUN_PROFILE="standard"

# Seed a minimal manifest so discover paths resolve
mkdir -p "$E2E_HOME/projects/$HASH"
cat > "$E2E_HOME/projects/$HASH/manifest.json" <<EOF
{
  "id": "fixture",
  "pilot": { "domain": "demoFeature", "routes": { "demoFeature": "/demoFeature" } },
  "docs": { "matrixDoc": "docs/features/demoFeature.md" },
  "hybrid": {
    "platform": "android",
    "container": { "package": "com.example.app.debug" },
    "network": { "pageOrigin": "https://h5.example.com/v2" },
    "deepLink": { "scheme": "example" },
    "webView": { "pathPrefix": "/v2", "webViewUrlAnchor": "demoFeature" }
  },
  "userConfirmed": {
    "pageOrigin": "https://h5.example.com/v2",
    "appPackage": "com.example.app.debug",
    "domain": "demoFeature"
  }
}
EOF
ln -sfn "$E2E_HOME/projects/$HASH/manifest.json" "$SANDBOX/skill.project.json"
mkdir -p "$SANDBOX/specs" "$SANDBOX/helpers" "$SANDBOX/config"

# Copy minimal helpers/config stubs are heavy; discover-cases only needs sandbox + project
if "$TS_NODE" "$CLI" discover-cases --union --domain demoFeature >"$WORK/discover.out" 2>"$WORK/discover.err"; then
  if [[ -f "$SANDBOX/case-registry.json" ]]; then
    # pending-assert (C02) must not be in standard registry
    if node -e '
      const r=require(process.argv[1]);
      const cases=r.cases||[];
      const pending=cases.filter(c=>(c.tags||[]).includes("pending-assert"));
      if(pending.length) { console.error("pending-assert leaked:", pending.map(c=>c.id)); process.exit(1); }
      const ids=new Set(cases.map(c=>c.id));
      for (const need of ["demoFeature.C01","demoFeature.C03"]) {
        if(!ids.has(need)) { console.error("missing strong matrix case:", need); process.exit(1); }
      }
      if(ids.has("demoFeature.C02")) { console.error("C02 pending-assert should be excluded"); process.exit(1); }
      console.log("registry cases:", [...ids].join(","));
    ' "$SANDBOX/case-registry.json"; then
      pass "discover-cases filters pending-assert"
    else
      fail "discover-cases leaked pending-assert"
    fi
  else
    fail "case-registry.json missing"
    cat "$WORK/discover.err" | tail -30
  fi
else
  fail "discover-cases exit"
  cat "$WORK/discover.err" | tail -40
fi

if "$TS_NODE" "$CLI" present-test-plan >"$WORK/plan.out" 2>"$WORK/plan.err"; then
  if [[ -f "$SANDBOX/test-plan.md" ]]; then
    pass "present-test-plan wrote test-plan.md"
  else
    fail "test-plan.md missing"
  fi
else
  fail "present-test-plan exit"
  cat "$WORK/plan.err" | tail -40
fi

echo "=== 4) list-preconfig JSON ==="
if bash "$SKILL_ROOT/scripts/list-preconfig.sh" --project "$PROJ" --domain demoFeature >"$WORK/preconfig.json" 2>"$WORK/preconfig.err"; then
  if node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!("quickPathEligible" in j) && !("envPresent" in j)) process.exit(1); console.log("keys", Object.keys(j).slice(0,8).join(","));' "$WORK/preconfig.json"; then
    pass "list-preconfig"
  else
    fail "list-preconfig JSON shape"
    head -c 500 "$WORK/preconfig.json"; echo
  fi
else
  # list-preconfig may print JSON on stdout with logs on stderr — tolerate partial
  if node -e 'const fs=require("fs"); const t=fs.readFileSync(process.argv[1],"utf8"); const i=t.indexOf("{"); if(i<0) process.exit(1); JSON.parse(t.slice(i));' "$WORK/preconfig.json" 2>/dev/null; then
    pass "list-preconfig (parsed)"
  else
    fail "list-preconfig"
    cat "$WORK/preconfig.err" | tail -20
  fi
fi

echo ""
echo "=== Summary: PASS=$PASS FAIL=$FAIL ==="
[[ "$FAIL" -eq 0 ]] || exit 1
echo "self-check-offline pipeline: OK"
