import fs from "node:fs";
import path from "node:path";
import type { AuthSignal } from "./auth-detect";

export const AUTH_RECOVERY_EXIT_CODE = 42;

const ARTIFACT_NAME = "auth-recovery.json";

export type AuthRecoveryArtifact = {
	caseId: string;
	title: string;
	signals: AuthSignal[];
	resolution: "AUTH_RECOVERY";
	at: string;
};

export function writeAuthRecoveryArtifact(
	payload: Omit<AuthRecoveryArtifact, "resolution" | "at">,
): string {
	const dir = path.join(process.cwd(), "e2e-device", "artifacts");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, ARTIFACT_NAME);
	const doc: AuthRecoveryArtifact = {
		...payload,
		resolution: "AUTH_RECOVERY",
		at: new Date().toISOString(),
	};
	fs.writeFileSync(file, JSON.stringify(doc, null, 2), "utf-8");
	return file;
}

export class AuthRecoveryError extends Error {
	readonly exitCode = AUTH_RECOVERY_EXIT_CODE;
	readonly artifactPath: string;

	constructor(message: string, artifactPath: string) {
		super(message);
		this.name = "AuthRecoveryError";
		this.artifactPath = artifactPath;
	}
}

export function throwAuthRecovery(
	caseId: string,
	title: string,
	signals: AuthSignal[],
): never {
	const artifactPath = writeAuthRecoveryArtifact({ caseId, title, signals });
	throw new AuthRecoveryError(
		`AUTH_RECOVERY required for case ${caseId}. See ${artifactPath}`,
		artifactPath,
	);
}
