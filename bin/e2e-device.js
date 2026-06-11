#!/usr/bin/env node
/**
 * e2e-device CLI — Android USB Hybrid 真机 E2E 统一入口
 */
"use strict";
const child_process_1 = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SKILL_ROOT = process.env.E2E_DEVICE_SKILL_ROOT ||
  path.join(os.homedir(), ".agents", "skills", "e2e-device");
const RUN_SCRIPT = path.join(SKILL_ROOT, "scripts", "run.sh");
const E2E_HOME = process.env.E2E_HOME || path.join(os.homedir(), ".e2e-device");

const HELP = `
e2e-device — Android USB Hybrid 真机 E2E (Appium + WebdriverIO)

用法:
  e2e-device run       --project <path> [选项]    执行真机 E2E 测试
  e2e-device plan      --project <path> [选项]    仅生成测试计划
  e2e-device info                                 展示产物分布
  e2e-device clean     [--project <path>] [选项]   清理产物
  e2e-device probe     --project <path>           探测设备环境
  e2e-device preflight                            系统预检

选项:
  --project, -p <path>   项目根路径
  --domain, -d <name>    domain 名称
  --mode, -m <mode>      执行模式: quick(默认) | resilience
  --sandbox              清理 sandbox/
  --logs                 清理 logs/
  --all                  清理 sandbox/ + logs/
  --system               完全清除 E2E_HOME

产物根目录: ${E2E_HOME}
  (可通过 export E2E_HOME=/custom/path 修改)
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" || a === "-p") opts.project = argv[++i];
    else if (a === "--domain" || a === "-d") opts.domain = argv[++i];
    else if (a === "--mode" || a === "-m") opts.mode = argv[++i];
    else if (a === "--clean") opts.clean = true;
    else if (a === "--all") opts.all = true;
    else if (a === "--sandbox") opts.sandbox = true;
    else if (a === "--logs") opts.logs = true;
    else if (a === "--system") opts.system = true;
    else if (a === "--plan-only") opts.planOnly = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (!a.startsWith("-")) opts._.push(a);
  }
  return opts;
}

function exec(cmd, args, opts) {
  return child_process_1.spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...opts.env },
  });
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + "K";
  return (bytes/(1024*1024)).toFixed(1) + "M";
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString("zh-CN"); } catch { return iso; }
}

function dirSize(dir) {
  try {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirSize(p);
      else if (entry.isFile()) total += fs.statSync(p).size;
    }
    return total;
  } catch { return 0; }
}

function cmdInfo() {
  console.log("");
  console.log("E2E_HOME: " + E2E_HOME + " (" + fmtSize(dirSize(E2E_HOME)) + ")");
  
  // 依赖版本 (直接调用二进制)
  try {
    const appiumBin = path.join(SKILL_ROOT, "node_modules", ".bin", "appium");
    const wdioBin = path.join(SKILL_ROOT, "node_modules", ".bin", "wdio");
    const driverPkg = path.join(os.homedir(), ".appium", "node_modules", "appium-uiautomator2-driver", "package.json");
    
    if (require("fs").existsSync(appiumBin)) {
      const v = require("child_process").execFileSync(appiumBin, ["--version"], { encoding: "utf-8", timeout: 5000 }).trim();
      console.log("  Appium".padEnd(16) + v);
    }
    if (require("fs").existsSync(driverPkg)) {
      const v = JSON.parse(require("fs").readFileSync(driverPkg, "utf-8")).version;
      console.log("  UIA2 Driver".padEnd(16) + v);
    }
    if (require("fs").existsSync(wdioBin)) {
      const v = require("child_process").execFileSync(wdioBin, ["--version"], { encoding: "utf-8", timeout: 5000 }).trim();
      console.log("  WebdriverIO".padEnd(16) + v);
    }
    console.log("  Node.js".padEnd(16) + process.version);
  } catch {}
  console.log("");

  const sections = [
    { name: "projects/", dir: path.join(E2E_HOME, "projects"), desc: "项目配置 (持久化, 勿删)" },
    { name: "sandbox/shared/", dir: path.join(E2E_HOME, "sandbox", "shared"), desc: "框架缓存 (可重建)" },
    { name: "sandbox/", dir: path.join(E2E_HOME, "sandbox"), desc: "执行沙箱 (可按需清理)", skipRoot: true },
    { name: "chromedriver/", dir: path.join(E2E_HOME, "chromedriver"), desc: "WebView 驱动 (preflight 下载)" },
    { name: "logs/", dir: path.join(E2E_HOME, "logs"), desc: "运行日志 (可清理)" },
  ];

  for (const s of sections) {
    if (!fs.existsSync(s.dir)) continue;
    const fileCount = countFiles(s.dir);
    const size = dirSize(s.dir);
    console.log("  " + s.name.padEnd(28) + fmtCount(fileCount) + "  " + fmtSize(size).padStart(6) + "    ← " + s.desc);
  }

  // Show chromedriver versions
  const cdMetaFile = path.join(E2E_HOME, "chromedriver", "versions.json");
  if (fs.existsSync(cdMetaFile)) {
    try {
      const meta = JSON.parse(fs.readFileSync(cdMetaFile, "utf-8"));
      const versions = meta.versions || {};
      for (const [key, info] of Object.entries(versions)) {
        const v = info;
        console.log("    └─ " + key.padEnd(28) + " Chrome " + v.webViewMajor + "  (" + v.deviceModel + ", " + fmtDate(v.lastUsed) + ")");
      }
    } catch {}
  }

  // Show sandbox sub-projects
  const sbDir = path.join(E2E_HOME, "sandbox");
  if (fs.existsSync(sbDir)) {
    for (const proj of fs.readdirSync(sbDir)) {
      if (proj === "shared" || proj.startsWith(".")) continue;
      const projDir = path.join(sbDir, proj);
      if (!fs.statSync(projDir).isDirectory()) continue;
      for (const domain of fs.readdirSync(projDir)) {
        const dd = path.join(projDir, domain);
        if (!fs.statSync(dd).isDirectory()) continue;
        console.log("    └─ " + proj + "/" + domain + "  " + fmtCount(countFiles(dd)) + "  " + fmtSize(dirSize(dd)).padStart(6));
      }
    }
  }

  console.log("");
  console.log("清理:");
  console.log("  e2e-device clean --sandbox     清理所有沙箱 (保留配置)");
  console.log("  e2e-device clean --logs        清理日志");
  console.log("  e2e-device clean --all         清理沙箱+日志 (保留配置)");
  console.log("  e2e-device clean --system      完全清除 " + E2E_HOME);
  console.log("  rm -rf " + E2E_HOME + "           等效 --system");
  console.log("");
  console.log("详细说明: " + path.join(E2E_HOME, "README.md"));
  console.log("");
}

function countFiles(dir) {
  try {
    let count = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
      else if (entry.isFile()) count++;
    }
    return count;
  } catch { return 0; }
}

function fmtCount(n) {
  if (n === 0) return "0 文件";
  return n + " 文件";
}

function cmdClean(opts) {
  if (opts.system) {
    console.log("完全清除 " + E2E_HOME + " ...");
    fs.rmSync(E2E_HOME, { recursive: true, force: true });
    console.log("✅ 已清除");
    return;
  }

  if (opts.all || opts.sandbox) {
    const sb = path.join(E2E_HOME, "sandbox");
    if (fs.existsSync(sb)) { fs.rmSync(sb, { recursive: true, force: true }); console.log("✅ sandbox/ 已清除"); }
    else console.log("sandbox/ 不存在");
  }

  if (opts.all || opts.logs) {
    const lg = path.join(E2E_HOME, "logs");
    if (fs.existsSync(lg)) { fs.rmSync(lg, { recursive: true, force: true }); console.log("✅ logs/ 已清除"); }
    else console.log("logs/ 不存在");
  }

  if (!opts.all && !opts.sandbox && !opts.logs && !opts.system) {
    console.log("用法: e2e-device clean [--sandbox|--logs|--all|--system]");
    console.log("  --sandbox  清理沙箱 (保留配置)");
    console.log("  --logs     清理日志");
    console.log("  --all      清理沙箱+日志 (保留配置)");
    console.log("  --system   完全清除 " + E2E_HOME);
  }
}

function cmdRun(opts) {
  if (!opts.project) { console.error("错误: 需要 --project <项目路径>"); process.exit(1); }
  const args = ["--project", path.resolve(opts.project)];
  if (opts.domain) args.push("--domain", opts.domain);
  if (opts.mode) args.push("--mode", opts.mode);
  if (opts.planOnly) args.push("--plan-only");
  if (opts.clean) args.push("--clean");
  const result = exec("bash", [RUN_SCRIPT, ...args], {
    env: { E2E_DEVICE_SKILL_ROOT: SKILL_ROOT, E2E_HOME: E2E_HOME },
  });
  process.exit(result.status || 0);
}

// ─── Main ──────────────────────────────────────────
const opts = parseArgs(process.argv.slice(2));
const cmd = opts._[0] || "run";

if (opts.help || !cmd) { console.log(HELP); process.exit(0); }

switch (cmd) {
  case "run":
  case "plan":
    cmdRun({ ...opts, planOnly: cmd === "plan" || opts.planOnly });
    break;
  case "info":
    cmdInfo();
    break;
  case "clean":
    cmdClean(opts);
    break;
  default:
    console.error("未知命令: " + cmd);
    console.log(HELP);
    process.exit(1);
}
