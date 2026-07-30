#!/usr/bin/env node
/**
 * SSOT: project path hash for E2E_HOME namespaces.
 * Must match assets/scaffold/orchestration/paths.ts projectHash().
 */
import path from "node:path";

export function projectHash(projectRoot) {
  return Buffer.from(path.resolve(projectRoot))
    .toString("base64")
    .replace(/\//g, "_")
    .replace(/\+/g, "-")
    .replace(/=/g, "")
    .slice(0, 32);
}

if (process.argv[1] && process.argv[1].endsWith("project-hash.mjs")) {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: node project-hash.mjs <projectRoot>");
    process.exit(1);
  }
  process.stdout.write(projectHash(root));
}
