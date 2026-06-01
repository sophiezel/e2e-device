import fs from "node:fs";
import path from "node:path";
import { loadProjectManifest } from "../config/project-manifest";
import { repoRoot } from "../orchestration/paths";

export type FixtureBody = Record<string, unknown>;

function fixtureRoot(): string {
	try {
		const m = loadProjectManifest();
		const dir = m.mock?.fixtureDir || "e2e-device/fixtures";
		return path.join(repoRoot(), dir);
	} catch {
		return path.join(repoRoot(), "e2e-device", "fixtures");
	}
}

export function loadFixture(relativePath: string): FixtureBody {
	const root = fixtureRoot();
	const candidates = [
		path.join(root, relativePath),
		path.join(root, "misjudge", relativePath),
	];
	for (const filePath of candidates) {
		if (fs.existsSync(filePath)) {
			const raw = fs.readFileSync(filePath, "utf-8");
			return JSON.parse(raw) as FixtureBody;
		}
	}
	throw new Error(
		`Fixture not found: ${relativePath} (tried under ${root})`,
	);
}
