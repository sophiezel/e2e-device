import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ============================================================================
// v2 Architecture: zero artifacts in project directory.
// All E2E artifacts live under E2E_HOME (~/.e2e-device/).
// Project path is read-only (source discovery, route analysis, report output).
// ============================================================================

// ---- Skill self-discovery (~/.agents/skills/e2e-device/) ----

/** Skill root directory: ~/.agents/skills/e2e-device/ */
export function e2eDeviceRoot(): string {
  return (
    process.env.E2E_DEVICE_SKILL_ROOT ||
    path.join(
      process.env.HOME || process.env.USERPROFILE || "/tmp",
      ".agents",
      "skills",
      "e2e-device",
    )
  );
}

/** Skill's scripts/ directory (contains e2e-device.js, bash helpers, node_modules/) */
export function scriptsDir(): string {
  return path.join(e2eDeviceRoot(), "scripts");
}

/** Skill's assets/scaffold/ directory (templates, config, specs, orchestration TS) */
export function scaffoldDir(): string {
  return path.join(e2eDeviceRoot(), "assets", "scaffold");
}

/** scripts/node_modules/.bin/ (for wdio, appium, etc.) */
export function nodeModulesBin(): string {
  return path.join(scriptsDir(), "node_modules", ".bin");
}

// ---- E2E_HOME (~/.e2e-device/) ----

/** E2E_HOME: defaults to ~/.e2e-device/ */
export function e2eHome(): string {
  return (
    process.env.E2E_HOME ||
    path.join(
      process.env.HOME || process.env.USERPROFILE || "/tmp",
      ".e2e-device",
    )
  );
}

// ---- Project identity (read-only, no artifacts written here) ----

/**
 * The project under test.
 * Priority: E2E_PROJECT_ROOT env, then process.cwd().
 */
export function repoRoot(): string {
  if (process.env.E2E_PROJECT_ROOT && fs.existsSync(process.env.E2E_PROJECT_ROOT)) {
    return process.env.E2E_PROJECT_ROOT;
  }
  return process.cwd();
}

/**
 * Stable 16-char hex hash of the project's resolved absolute path.
 * Used as a namespace key under E2E_HOME/projects/ and E2E_HOME/sandbox/.
 */
export function projectHash(projectRoot: string): string {
  return crypto
    .createHash("sha256")
    .update(path.resolve(projectRoot))
    .digest("hex")
    .slice(0, 16);
}

// ---- Project cache (in E2E_HOME, not in project) ----

/** E2E_HOME/projects/{projectHash}/ — per-project state directory */
export function projectCacheDir(projectRoot: string): string {
  return path.join(e2eHome(), "projects", projectHash(projectRoot));
}

/**
 * Case cache file path.
 * E2E_HOME/projects/{projectHash}/case-cache/{branch}/{domain}.json
 */
export function caseCacheFile(
  projectHashStr: string,
  branch: string,
  domain: string,
): string {
  return path.join(
    e2eHome(),
    "projects",
    projectHashStr,
    "case-cache",
    branch,
    `${domain}.json`,
  );
}

/** E2E_HOME/projects/ — all per-project state directories live here. */
export function projectsDir(): string {
  return path.join(e2eHome(), "projects");
}

// ---- Sandbox (all runtime artifacts land here) ----

/**
 * Legacy convenience: resolves sandbox base from current project + domain.
 * @deprecated Prefer sandboxRoot(projectHash, domain) for explicit control.
 */
export function sandboxDir(): string {
  const hash = projectHash(repoRoot());
  const domain = process.env.E2E_DOMAIN ?? "default";
  return sandboxRoot(hash, domain);
}

/** E2E_HOME/sandbox/{projectHash}/{domain}/ */
export function sandboxRoot(projectHashStr: string, domain: string): string {
  return path.join(e2eHome(), "sandbox", projectHashStr, domain);
}

/** Sandbox artifacts: sandbox/artifacts/runs/{runId}/ */
export function artifactsRoot(
  projectHashStr?: string,
  domain?: string,
  runId?: string,
): string {
  const hash = projectHashStr ?? projectHash(repoRoot());
  const dom = domain ?? process.env.E2E_DOMAIN ?? "default";
  const rid = runId ?? resolveRunId();
  return path.join(sandboxRoot(hash, dom), "artifacts", "runs", rid);
}

/** Progress file: sandbox/artifacts/runs/{runId}/progress.jsonl */
export function progressFile(
  projectHashStr: string,
  domain: string,
  runId: string,
): string {
  return path.join(artifactsRoot(projectHashStr, domain, runId), "progress.jsonl");
}

// ---- Reports ----

/**
 * Report output directory.
 * Uses E2E_REPORT_PATH env var if set, otherwise PROJECT/docs/.
 */
export function reportDir(projectRoot: string): string {
  if (process.env.E2E_REPORT_PATH) return process.env.E2E_REPORT_PATH;
  return path.join(projectRoot, "docs");
}

// ---- Run ID resolution ----

function resolveRunId(): string {
  let id = process.env.E2E_RUN_ID ?? "";
  if (!id) {
    const idFile = path.join(e2eDeviceRoot(), ".e2e-run-id");
    if (fs.existsSync(idFile)) {
      id = fs.readFileSync(idFile, "utf-8").trim();
    }
  }
  return id || `run-${Date.now()}`;
}

// ---- Legacy: convenience helpers kept for caller compatibility ----

/**
 * Convenience wrapper: resolves run artifacts directory from env state.
 * @deprecated Prefer artifactsRoot(projectHash, domain, runId) for explicit control.
 */
export function runDir(runId?: string): string {
  const id = runId ?? resolveRunId();
  const hash = projectHash(repoRoot());
  const domain = process.env.E2E_DOMAIN ?? "default";
  return artifactsRoot(hash, domain, id);
}

// ---- Project config (read from cache, write only to cache) ----

export function projectConfigPath(): string {
  const root = repoRoot();
  const hash = projectHash(root);
  const cacheFile = path.join(e2eHome(), "projects", hash, "config.json");
  if (fs.existsSync(cacheFile)) return cacheFile;
  // First run: try reading from project file (read-only, never writes back)
  const projectFile = path.join(root, "e2e-device", "skill.project.json");
  if (fs.existsSync(projectFile)) return projectFile;
  return cacheFile;
}

export function projectConfigWritePath(): string {
  const root = repoRoot();
  const hash = projectHash(root);
  return path.join(e2eHome(), "projects", hash, "config.json");
}

export function saveProjectConfig(data: Record<string, unknown>): string {
  const dest = projectConfigWritePath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(data, null, 2), "utf-8");
  return dest;
}

// ---- Shared path accessor object (backward-compatible) ----

function resolveInSandbox(subPath: string): string {
  // All sandbox-pathed files resolve within the skill root or E2E_HOME sandbox.
  // Never falls back to the project directory (zero-artifact policy).
  const sandboxOverride = process.env.E2E_SANDBOX;
  if (sandboxOverride) return path.join(sandboxOverride, subPath);

  // Default: within skill's e2eDeviceRoot
  return path.join(e2eDeviceRoot(), subPath);
}

export const paths = {
  projectJson: () => projectConfigPath(),
  projectJsonWrite: () => projectConfigWritePath(),
  projectYaml: () => resolveInSandbox("skill.project.yaml"),
  localJson: () => resolveInSandbox(".e2e-local.json"),
  runJson: () => resolveInSandbox(".e2e-run.json"),
  caseRegistry: () => resolveInSandbox("case-registry.json"),
  chaosRegistry: () => resolveInSandbox(path.join("chaos", "chaos-case-registry.json")),
  diffInferred: () => resolveInSandbox("diff-inferred-cases.json"),
  scaffoldVersion: () => resolveInSandbox(".e2e-scaffold-version"),
  authRecovery: () => resolveInSandbox(path.join("artifacts", "auth-recovery.json")),
};

// ---- Template / inject helpers (kept for existing callers) ----

export function skillTemplatesRoot(): string {
  const fromEnv =
    process.env.E2E_DEVICE_SKILL_ROOT ??
    process.env.DEVICE_E2E_SKILL_TEMPLATES;
  if (fromEnv && fs.existsSync(fromEnv)) {
    const scaffold = path.join(fromEnv, "assets", "scaffold");
    if (fs.existsSync(scaffold)) return scaffold;
    if (fs.existsSync(fromEnv)) return fromEnv;
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const dir = path.join(home, ".agents", "skills", "e2e-device", "assets", "scaffold");
  if (fs.existsSync(dir)) return dir;

  // Legacy fallback
  const legacy = path.join(home, ".agents", "skills", "device-e2e", "assets", "scaffold");
  if (fs.existsSync(legacy)) return legacy;

  return scaffoldDir();
}

export function injectScriptPath(): string {
  return path.join(e2eDeviceRoot(), "assets", "scaffold", "inject", "web-request-mock.js");
}
