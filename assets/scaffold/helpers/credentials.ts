/**
 * E2E credentials: env vars override gitignored credentials.json.
 */
import fs from "node:fs";
import path from "node:path";

export function applyCredentials(): void {
	if (process.env.E2E_ACCOUNT && process.env.E2E_PASSWORD) {
		return;
	}
	try {
		const credPath = path.join(__dirname, "..", "config", "credentials.json");
		const raw = fs.readFileSync(credPath, "utf-8");
		const mod = JSON.parse(raw) as {
			E2E_ACCOUNT?: string;
			E2E_PASSWORD?: string;
		};
		if (mod.E2E_ACCOUNT && !process.env.E2E_ACCOUNT) {
			process.env.E2E_ACCOUNT = mod.E2E_ACCOUNT;
		}
		if (mod.E2E_PASSWORD && !process.env.E2E_PASSWORD) {
			process.env.E2E_PASSWORD = mod.E2E_PASSWORD;
		}
	} catch {
		// credentials.json optional
	}
}

export function hasCredentials(): boolean {
	applyCredentials();
	return !!(process.env.E2E_ACCOUNT && process.env.E2E_PASSWORD);
}
