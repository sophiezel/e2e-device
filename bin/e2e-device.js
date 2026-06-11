#!/usr/bin/env node
/**
 * e2e-device CLI — Android USB Hybrid 真机 E2E 统一入口
 * 
 * 用法:
 *   e2e-device run    --project <path> [--domain <name>] [--mode quick|resilience]
 *   e2e-device plan   --project <path> [--domain <name>]
 *   e2e-device clean  [--project <path>] [--all]
 *   e2e-device probe  --project <path>
 *   e2e-device preflight
 *   e2e-device --help
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SKILL_ROOT = process.env.E2E_DEVICE_SKILL_ROOT ||
  path.join(os.homedir(), ".agents", "skills", "e2e-device");
const RUN_SCRIPT = path.join(SKILL_ROOT, "scripts", "run.sh");
const TMP_ROOT = (process.env.E2E_TMPDIR ||
  path.join(process.env.TMPDIR || os.tmpdir(), "e2e-device")).replace(/\/+$/, "");

const HELP = `
e2e-device — Android USB Hybrid 真机 E2E (Appium + WebdriverIO)

用法:
  e2e-device run    --project <path> [选项]    执行真机 E2E 测试
  e2e-device plan   --project <path> [选项]    仅生成测试计划
  e2e-device clean  [--project <path>] [--all]  清理沙箱/缓存
  e2e-device probe  --project <path>           探测设备环境
  e2e-device preflight                         系统预检

示例:
  e2e-device run --project /path/to/jian-h5
  e2e-device run --project . --domain evaluateRecovery --mode resilience
  e2e-device clean --project . --all
  e2e-device clean --system

环境变量:
  E2E_ACCOUNT / E2E_PASSWORD   登录凭据 (仅 env, 禁止写入文件)
  E2E_PAGE_ORIGIN              H5 部署域名
  E2E_DEVICE_PIN               设备锁屏 PIN
  E2E_RUN_PROFILE              quick(默认) | standard | resilience
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" || a === "-p") { opts.project = argv[++i]; }
    else if (a === "--domain" || a === "-d") { opts.domain = argv[++i]; }
    else if (a === "--mode" || a === "-m") { opts.mode = argv[++i]; }
    else if (a === "--clean") { opts.clean = true; }
    else if (a === "--all") { opts.all = true; }
    else if (a === "--system") { opts.system = true; }
    else if (a === "--plan-only") { opts.planOnly = true; }
    else if (a === "--help" || a === "-h") { opts.help = true; }
    else if (!a.startsWith("-")) { opts._.push(a); }
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

// ─── Commands ──────────────────────────────────────

function cmdRun(opts) {
  if (!opts.project) {
    console.error("错误: 需要 --project <项目路径>");
    process.exit(1);
  }
  // delegate to run.sh
  const args = ["--project", path.resolve(opts.project)];
  if (opts.domain) args.push("--domain", opts.domain);
  if (opts.mode) args.push("--mode", opts.mode);
  if (opts.planOnly) args.push("--plan-only");
  if (opts.clean) args.push("--clean");

  const result = exec("bash", [RUN_SCRIPT, ...args], {
    env: {
      E2E_DEVICE_SKILL_ROOT: SKILL_ROOT,
    },
  });
  process.exit(result.status || 0);
}

function cmdClean(opts) {
  if (opts.system) {
    console.log("清理整个 /tmp/e2e-device/ ...");
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    console.log("✅ 已清理");
    return;
  }

  if (opts.project) {
    const projName = path.basename(path.resolve(opts.project));
    const projDir = path.join(TMP_ROOT, projName);
    if (fs.existsSync(projDir)) {
      if (opts.all || opts.domain) {
        const target = opts.domain
          ? path.join(projDir, opts.domain)
          : projDir;
        fs.rmSync(target, { recursive: true, force: true });
        console.log(`✅ 已清理: ${target}`);
      } else {
        // 只清理 artifacts
        const artifactsDirs = findDirs(projDir, "artifacts");
        for (const d of artifactsDirs) {
          fs.rmSync(d, { recursive: true, force: true });
          console.log(`✅ 已清理: ${d}`);
        }
        if (artifactsDirs.length === 0) {
          console.log("无 artifacts 可清理。用 --all 清理整个项目沙箱。");
        }
      }
    } else {
      console.log(`沙箱不存在: ${projDir}`);
    }
  }

  // Clean shared/ only with --all or explicit
  const sharedDir = path.join(TMP_ROOT, "shared");
  if (opts.all && fs.existsSync(sharedDir)) {
    fs.rmSync(sharedDir, { recursive: true, force: true });
    console.log(`✅ 已清理: ${sharedDir}`);
  }
}

function findDirs(root, name) {
  const result = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === name) result.push(full);
        result.push(...findDirs(full, name));
      }
    }
  } catch { /* ignore */ }
  return result;
}

function cmdProbe(opts) {
  if (!opts.project) {
    console.error("错误: 需要 --project <项目路径>");
    process.exit(1);
  }
  const args = ["--project", path.resolve(opts.project), "--plan-only"];
  const result = exec("bash", [RUN_SCRIPT, ...args], {
    env: {
      E2E_DEVICE_SKILL_ROOT: SKILL_ROOT,
      E2E_PROJECT_ROOT: path.resolve(opts.project),
    },
  });
  // Run probe after plan setup
  const tsnode = path.join(SKILL_ROOT, "node_modules", ".bin", "ts-node");
  const cli = path.join(SKILL_ROOT, "orchestration", "cli.ts");
  exec(tsnode, [cli, "probe-env"], {
    env: {
      E2E_DEVICE_SKILL_ROOT: SKILL_ROOT,
      E2E_PROJECT_ROOT: path.resolve(opts.project),
    },
  });
}

function cmdPreflight() {
  const tsnode = path.join(SKILL_ROOT, "node_modules", ".bin", "ts-node");
  const cli = path.join(SKILL_ROOT, "orchestration", "cli.ts");
  exec(tsnode, [cli, "preflight"], {
    env: { E2E_DEVICE_SKILL_ROOT: SKILL_ROOT },
  });
}

// ─── Main ──────────────────────────────────────────

const opts = parseArgs(process.argv.slice(2));
const cmd = opts._[0] || "run";

if (opts.help || !cmd) {
  console.log(HELP);
  process.exit(0);
}

switch (cmd) {
  case "run":    cmdRun(opts); break;
  case "plan":   cmdRun({ ...opts, planOnly: true }); break;
  case "clean":  cmdClean(opts); break;
  case "probe":  cmdProbe(opts); break;
  case "preflight": cmdPreflight(); break;
  default:
    console.error(`未知命令: ${cmd}`);
    console.log(HELP);
    process.exit(1);
}
