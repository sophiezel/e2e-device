import fs from "node:fs";
import path from "node:path";
import { scaffoldDir } from "./paths";

/** Resolve binary only from the host repo (no cross-repo node_modules). */
export function resolveBin(name: string, root: string): string | null {
	const bin = path.join(root, "node_modules", ".bin", name);
	if (fs.existsSync(bin)) {
		return bin;
	}
	return null;
}

export function wdioArgv(root: string, specArgs: string[]): string[] {
	const wdio = resolveBin("wdio", root);
	const wdioConf = path.join(scaffoldDir(), "wdio.conf.ts");
	if (wdio) {
		return [wdio, "run", wdioConf, ...specArgs];
	}
	throw new Error(
		"wdio not found in host node_modules. Run: bash e2e-device/scripts/ensure-host-deps.sh wdio",
	);
}
