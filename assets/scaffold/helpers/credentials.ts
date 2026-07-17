/**
 * E2E credentials: environment variables / CI secrets only.
 * credentials.json is forbidden (ADR-0003 short-term: env-only; Keychain is future work).
 */
export function applyCredentials(): void {
	// No-op: callers must rely on process.env.E2E_ACCOUNT / E2E_PASSWORD already set.
	// Intentionally does not read any credential files.
}

export function hasCredentials(): boolean {
	return !!(process.env.E2E_ACCOUNT && process.env.E2E_PASSWORD);
}

/** Mask account for logs: keep first 2 + last 2 chars. */
export function maskAccount(account: string): string {
	const s = String(account || "");
	if (s.length <= 4) return "****";
	return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

/** Always mask password in logs. */
export function maskPassword(_password?: string): string {
	return "****";
}
