import fs from "node:fs";
import path from "node:path";
import { loadProjectManifest } from "../config/project-manifest";
import { repoRoot } from "../orchestration/paths";

export type FixtureBody = Record<string, unknown>;

function fixtureRoot(): string {
	const m = loadProjectManifest();
	const dir = m.mock?.fixtureDir;
	if (!dir) {
		throw new Error(
			"fixtureDir not set in project manifest (mock.fixtureDir). " +
			"Please run discover to generate skill.project.yaml first.",
		);
	}
	return path.join(repoRoot(), dir);
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
