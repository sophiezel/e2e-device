import fs from "node:fs";
import { paths } from "../orchestration/paths";

const SENSITIVE_KEYS = new Set([
	"E2E_ACCOUNT",
	"E2E_PASSWORD",
	"E2E_TOKEN",
]);

export interface E2eLocalConfig {
	version: number;
	initialized?: boolean;
	initializedAt?: string;
	lastProbeAt?: string;
	lastRequirementId?: string;
	env: Record<string, string>;
	probeSnapshot?: Record<string, unknown>;
	app?: {
		android?: {
			appPackage: string;
			appActivity: string;
		};
		h5?: {
			pageOrigin: string;
		};
	};
}

export function readLocalConfig(): E2eLocalConfig | null {
	const file = paths.localJson();
	if (!fs.existsSync(file)) {
		return null;
	}
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as E2eLocalConfig;
	} catch {
		return null;
	}
}

export function applyLocalConfigToEnv(): void {
	const local = readLocalConfig();
	if (!local?.env) {
		return;
	}
	for (const [key, value] of Object.entries(local.env)) {
		if (SENSITIVE_KEYS.has(key)) {
			continue;
		}
		if (process.env[key] === undefined && value !== undefined && value !== "") {
			process.env[key] = String(value);
		}
	}
}

export function writeLocalConfig(partial: Partial<E2eLocalConfig>): E2eLocalConfig {
	const file = paths.localJson();
	const prev = readLocalConfig() || {
		version: 1,
		env: {},
	};
	const next: E2eLocalConfig = {
		...prev,
		...partial,
		env: { ...prev.env, ...(partial.env || {}) },
		probeSnapshot: partial.probeSnapshot ?? prev.probeSnapshot,
	};
	fs.mkdirSync(require("node:path").dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf-8");
	return next;
}
