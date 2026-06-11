import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { repoRoot } from "./paths";
import { loadProjectManifest } from "../config/project-manifest";
import { getRunProfile, type RunProfile } from "../config/run-profile";

export interface IntentResult {
	requirementId: string;
	domain: string;
	sources: string[];
	userIntent?: string;
	profile: RunProfile;
}

/**
 * 根据用户意图解析运行模式
 */
function parseIntentProfile(userIntent?: string): RunProfile {
	// 默认 quick 模式（SKILL.md 规约）
	if (!userIntent || userIntent.trim() === "") {
		const fromEnv = getRunProfile();
		// getRunProfile 返回 unknown 时默认 quick
		return fromEnv === "unknown" ? "quick" : fromEnv;
	}

	const lower = userIntent.toLowerCase();

	// 混沌测试 → resilience
	if (
		lower.includes("混沌测试") ||
		lower.includes("混沌") ||
		lower.includes("chaos") ||
		lower.includes("resilience")
	) {
		return "resilience";
	}

	// 全量测试 → standard
	if (
		lower.includes("全量测试") ||
		lower.includes("全量") ||
		lower.includes("完整测试") ||
		lower.includes("standard")
	) {
		return "standard";
	}

	// 快速测试 → quick
	if (
		lower.includes("快速测试") ||
		lower.includes("快速") ||
		lower.includes("quick")
	) {
		return "quick";
	}

	// 默认使用环境变量或 quick
	return getRunProfile();
}

function gitDiffNames(): string[] {
	const bases = ["origin/main", "origin/master", "main", "master"];
	for (const base of bases) {
		try {
			const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
				cwd: repoRoot(),
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			const files = out.split("\n").filter(Boolean);
			if (files.length) {
				return files;
			}
		} catch {
			// try next base
		}
	}
	try {
		const out = execFileSync("git", ["diff", "--name-only", "HEAD~5"], {
			cwd: repoRoot(),
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return out.split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

function domainFromPath(file: string): string | null {
	const react = file.match(/src\/pages\/([^/]+)\//);
	if (react) {
		return react[1];
	}
	const vue = file.match(/src\/page\/([^/]+)\//);
	return vue?.[1] || null;
}

function scanGuaziFlow(domain: string): string[] {
	const root = path.join(repoRoot(), "docs", "guazi-flow");
	if (!fs.existsSync(root)) {
		return [];
	}
	return fs
		.readdirSync(root, { withFileTypes: true })
		.filter((d) => d.isDirectory() && d.name.includes(domain))
		.map((d) => `docs/guazi-flow/${d.name}/index.md`);
}

export function discoverIntent(userIntent?: string): IntentResult {
	const manifest = loadProjectManifest();
	const sources: string[] = [];
	const manifestPilot = manifest.pilot?.domain?.trim();
	let domain = manifestPilot || "app";

	// 解析用户意图中的运行模式
	const profile = parseIntentProfile(userIntent);

	if (manifestPilot) {
		sources.push("manifest-pilot");
	}

	if (userIntent) {
		sources.push("user-intent");
		const lower = userIntent.toLowerCase();
		for (const pagesDir of [
			path.join(repoRoot(), "src", "pages"),
			path.join(repoRoot(), "src", "page"),
		]) {
			if (!fs.existsSync(pagesDir)) {
				continue;
			}
			for (const name of fs.readdirSync(pagesDir)) {
				if (lower.includes(name.toLowerCase())) {
					domain = name;
					break;
				}
			}
		}
	}

	const diffFiles = gitDiffNames();
	if (diffFiles.length) {
		sources.push("git-diff");
		const allowDiffOverride =
			process.env.E2E_INTENT_USE_GIT_DIFF === "1" ||
			!manifestPilot ||
			manifestPilot === "app";
		if (allowDiffOverride) {
			for (const f of diffFiles) {
				const d = domainFromPath(f);
				if (d) {
					domain = d;
					break;
				}
			}
		}
	}

	const flowDocs = scanGuaziFlow(domain);
	if (flowDocs.length) {
		sources.push("guazi-flow");
	}

	if (!sources.length) {
		sources.push("manifest-pilot");
	}

	const requirementId = `${domain}-${new Date().toISOString().slice(0, 10)}`;

	return {
		requirementId,
		domain,
		sources,
		userIntent,
		profile,
	};
}
