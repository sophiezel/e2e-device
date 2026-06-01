/**
 * E2E credentials: env vars override gitignored credentials.ts.
 */
export function applyCredentials(): void {
	if (process.env.E2E_ACCOUNT && process.env.E2E_PASSWORD) {
		return;
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const mod = require("../config/credentials") as {
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
		// credentials.ts optional
	}
}

export function hasCredentials(): boolean {
	applyCredentials();
	return !!(process.env.E2E_ACCOUNT && process.env.E2E_PASSWORD);
}
