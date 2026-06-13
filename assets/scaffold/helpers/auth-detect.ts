import { loadProjectManifest } from "../config/project-manifest";
import { isLoginScreenVisible } from "./login";
import type { DiagnosticSnapshot } from "../resilience/types";

export type AuthSignal = {
	layer: "native" | "h5" | "api" | "bridgeToken";
	detail: string;
};

export async function collectAuthSignals(
	snapshot: DiagnosticSnapshot,
): Promise<AuthSignal[]> {
	const signals: AuthSignal[] = [];

	if (await isLoginScreenVisible()) {
		signals.push({ layer: "native", detail: "native_login_screen_visible" });
	}

	let manifest;
	try {
		manifest = loadProjectManifest();
	} catch {
		return signals;
	}

	const auth = manifest.hybrid.auth;
	const url = snapshot.url || "";
	const source = snapshot.pageSource || "";

	for (const pattern of auth?.h5?.loginPathPatterns || []) {
		if (pattern && url.includes(pattern)) {
			signals.push({ layer: "h5", detail: `url_matches:${pattern}` });
		}
	}

	for (const text of auth?.h5?.unauthTextPatterns || []) {
		if (text && source.includes(text)) {
			signals.push({ layer: "h5", detail: `dom_text:${text}` });
		}
	}

	for (const toast of snapshot.toastMessages || []) {
		for (const text of auth?.h5?.unauthTextPatterns || []) {
			if (text && toast.includes(text)) {
				signals.push({ layer: "h5", detail: `toast:${text}` });
			}
		}
	}

	for (const evt of snapshot.networkEvents || []) {
		const status = evt.statusCode;
		if (
			status &&
			(auth?.api?.unauthHttpStatuses || [401, 403]).includes(status)
		) {
			signals.push({
				layer: "api",
				detail: `http_${status}:${evt.url || ""}`,
			});
		}
		const preview = evt.bodyPreview || "";
		for (const code of auth?.api?.unauthBodyCodes || []) {
			if (
				preview.includes(`"code":${code}`) ||
				preview.includes(`"code":"${code}"`) ||
				preview.includes(`code=${code}`)
			) {
				signals.push({ layer: "api", detail: `body_code:${code}` });
			}
		}
	}

	if (
		signals.some((s) => s.layer === "api" || s.layer === "h5") &&
		!(await isLoginScreenVisible()) &&
		(auth?.layers || []).includes("bridgeToken")
	) {
		signals.push({
			layer: "bridgeToken",
			detail: "api_unauth_with_native_session",
		});
	}

	return signals;
}

export async function isAuthRequired(
	snapshot: DiagnosticSnapshot,
): Promise<{ required: boolean; signals: AuthSignal[] }> {
	const signals = await collectAuthSignals(snapshot);
	return { required: signals.length > 0, signals };
}
