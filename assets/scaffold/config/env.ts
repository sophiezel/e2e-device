/**
 * E2E data mode configuration.
 * Resolves the current data mode from environment variables.
 */
export function getE2eDataMode(): string {
	return process.env.E2E_DATA_MODE || "test";
}

/**
 * Check if mock data mode is active.
 */
export function isMockMode(): boolean {
	return (
		process.env.E2E_ENABLE_WEB_MOCK === "1" ||
		getE2eDataMode() === "mock"
	);
}
