export type RunProfile = "quick" | "standard" | "resilience";

export function getRunProfile(): RunProfile {
	const raw = (process.env.E2E_RUN_PROFILE || "quick").toLowerCase();
	if (raw === "standard" || raw === "resilience") {
		return raw;
	}
	return "quick";
}

export function applyProfileDefaults(): void {
	const profile = getRunProfile();
	process.env.E2E_RUN_PROFILE = profile;

	if (profile === "quick") {
		process.env.E2E_RESILIENCE_MODE = process.env.E2E_RESILIENCE_MODE || "expert";
		process.env.E2E_SUITE_SHARED_ENTRY = process.env.E2E_SUITE_SHARED_ENTRY || "1";
	}

	if (profile === "standard") {
		process.env.E2E_RESILIENCE_MODE = "full";
	}

	if (profile === "resilience") {
		process.env.E2E_RESILIENCE_MODE = process.env.E2E_RESILIENCE_MODE || "expert";
		process.env.E2E_SEQUENTIAL = "1";
	}
}
