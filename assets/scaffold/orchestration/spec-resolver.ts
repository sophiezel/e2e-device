/**
 * Shared spec-path resolver.
 *
 * Single source of truth for resolving a registry `spec` field to a filesystem path.
 * Used by: generate-journey-plan, l2-readiness, present-test-plan, run.sh cache audit.
 *
 * Resolution order:
 * 1. Absolute path → as-is
 * 2. sandbox/{spec}
 * 3. sandbox/specs/{spec}
 * 4. sandbox/chaos/{basename(spec)}
 * 5. Fallback: sandbox/specs/{basename(spec)}
 */
import fs from "node:fs";
import path from "node:path";
import { sandboxDir } from "./paths";

export function resolveSpecPath(spec: string, sandbox?: string): string {
	if (path.isAbsolute(spec)) return spec;
	const sb = sandbox || sandboxDir();
	const candidates = [
		path.join(sb, spec),
		path.join(sb, "specs", spec),
		path.join(sb, "chaos", path.basename(spec)),
	];
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	return path.join(sb, "specs", path.basename(spec));
}

/** Check whether a spec file exists on disk (resolves through resolveSpecPath). */
export function specExists(spec: string, sandbox?: string): boolean {
	const resolved = resolveSpecPath(spec, sandbox);
	return fs.existsSync(resolved);
}
