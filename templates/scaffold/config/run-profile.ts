export type RunProfile = "fast" | "full" | "recovery";

export function getRunProfile(): RunProfile {
	const raw = (process.env.E2E_RUN_PROFILE || "fast").toLowerCase();
	if (raw === "full" || raw === "recovery") {
		return raw;
	}
	return "fast";
}

export function applyProfileDefaults(): void {
	const profile = getRunProfile();
	process.env.E2E_RUN_PROFILE = profile;

	if (profile === "fast") {
		process.env.E2E_RESILIENCE_MODE = process.env.E2E_RESILIENCE_MODE || "expert";
		process.env.E2E_SUITE_SHARED_ENTRY = process.env.E2E_SUITE_SHARED_ENTRY || "1";
	}

	if (profile === "full") {
		process.env.E2E_RESILIENCE_MODE = "full";
	}

	if (profile === "recovery") {
		process.env.E2E_RESILIENCE_MODE = process.env.E2E_RESILIENCE_MODE || "expert";
		process.env.E2E_SEQUENTIAL = "1";
	}
}
