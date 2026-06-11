import fs from "node:fs";
import path from "node:path";
import type { CaseRecord, ResilienceRunSummary } from "../resilience/types";
import { discoverIntent } from "./discover-intent";
import { renderResilienceReportZh, renderRunArchiveZh } from "./render-report-zh";
import { artifactsRoot, e2eDeviceRoot, paths, repoRoot } from "./paths";
import { RUN_ID_FILE, RESILIENCE_REPORT_JSON, RESILIENCE_REPORT_MD } from "./constants";
import { loadCoverageResult, finalizeCoverage } from "./coverage";

/** Load human-readable descriptions for cases from case-registry.json */
function loadCaseDescriptions(): Map<string, string> {
	const map = new Map<string, string>();

	function loadFile(file: string): void {
		try {
			const registryPath = path.join(e2eDeviceRoot(), file);
			if (fs.existsSync(registryPath)) {
				const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
					cases?: Array<{
						id: string;
						name?: string;
						description?: string;
						metadata?: { description?: string; acceptanceCriteria?: string; operation?: string };
					}>;
				};
				for (const c of registry.cases || []) {
					const desc = c.metadata?.description || c.metadata?.acceptanceCriteria || c.metadata?.operation || c.description || c.name || c.id;
					map.set(c.id, desc);
				}
			}
		} catch { /* best-effort */ }
	}

	loadFile("case-registry.json");
	loadFile("case-registry/device-edge-cases.json");
	return map;
}

interface CaseMeta {
	operation?: string;
	acceptanceCriteria?: string;
	description?: string;
	name?: string;
	preconditions?: string;
	expectedResult?: string;
	steps: string[];
	fixes: Array<{ approach: string; risk: string; effort: string; refs: string[] }>;
}

/** Load full metadata from both registries for diagnostic enrichment */
function loadCaseMetadata(): Map<string, CaseMeta> {
	const map = new Map<string, CaseMeta>();

	function loadFile(file: string): void {
		try {
			const registryPath = path.join(e2eDeviceRoot(), file);
			if (fs.existsSync(registryPath)) {
				const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
					cases?: Array<{
						id: string;
						name?: string;
						description?: string;
						metadata?: {
							operation?: string;
							acceptanceCriteria?: string;
							description?: string;
							preconditions?: string;
							expectedResult?: string;
							suggestedFixes?: Array<{ approach: string; risk: string; effort: string; refs: string[] }>;
						};
						priority?: string;
					}>;
				};
				for (const c of registry.cases || []) {
					const m = c.metadata;
					const steps: string[] = [];
					if (c.name) steps.push(c.name);
					if (c.description && c.description !== c.name) steps.push(c.description);
					if (m?.operation && m.operation !== c.name) steps.push(m.operation);
					if (m?.expectedResult) steps.push(`预期: ${m.expectedResult}`);
					if (m?.acceptanceCriteria && m.acceptanceCriteria !== m.description) {
						steps.push(`验收标准: ${m.acceptanceCriteria}`);
					}
					map.set(c.id, {
						operation: m?.operation,
						acceptanceCriteria: m?.acceptanceCriteria,
						description: c.description || m?.description,
						name: c.name,
						preconditions: m?.preconditions,
						expectedResult: m?.expectedResult,
						steps: steps.length ? steps : [c.description || c.name || m?.operation || c.id],
						fixes: m?.suggestedFixes || [],
					});
				}
			}
		} catch { /* best-effort */ }
	}

	loadFile("case-registry.json");
	loadFile("case-registry/device-edge-cases.json");
	return map;
}

function enrichCaseTitles(cases: CaseRecord[]): void {
	const descMap = loadCaseDescriptions();
	const metaMap = loadCaseMetadata();
	for (const c of cases) {
		const desc = descMap.get(c.caseId);
		if (desc && c.title === c.caseId) c.title = desc;

		const meta = metaMap.get(c.caseId);
		if (meta) {
			// Test steps — 从 registry metadata 构建详细的测试路径
			if (!c.testSteps || c.testSteps.length === 0) {
				const steps: string[] = [];
				if (meta.preconditions) steps.push(`前置条件: ${meta.preconditions}`);
				if (meta.operation) steps.push(`操作: ${meta.operation}`);
				if (meta.acceptanceCriteria) steps.push(`验收: ${meta.acceptanceCriteria}`);
				if (meta.expectedResult) steps.push(`预期: ${meta.expectedResult}`);
				if (meta.description && !steps.length) steps.push(`测试: ${meta.description}`);
				if (steps.length === 0) steps.push(meta.operation || meta.acceptanceCriteria || meta.description || c.title);
				c.testSteps = steps;
			}

			// 复现路径 — 从 registry metadata 构建
			if (!c.reproductionPath && (meta.preconditions || meta.operation)) {
				c.reproductionPath = {
					deviceModel: process.env.E2E_DEVICE_MODEL || detectDeviceModelRuntime(),
					osVersion: process.env.E2E_DEVICE_OS || detectOsVersionRuntime(),
					networkCondition: "正常",
					stepsToReproduce: [
						`前提: ${meta.preconditions || "页面可访问"}`,
						`操作: ${meta.operation || "打开页面"}`,
						`预期: ${meta.expectedResult || "页面正常展示"}`,
						`失败: ${c.rootCause || c.error?.slice(0, 100) || "请查看错误详情"}`,
					],
					probability: "必现",
				};
			}

			// 修复建议 — 跟随框架级错误分类或 registry metadata
			if (!c.suggestedFixes || c.suggestedFixes.length === 0) {
				c.suggestedFixes = meta.fixes.length
					? meta.fixes.map((f: { approach: string; risk: string; effort: string; refs: string[] }) => ({
						caseId: c.caseId,
						approaches: [f.approach],
						risk: f.risk as "low" | "medium" | "high" | "unknown",
						estimatedEffort: f.effort,
						references: f.refs,
					}))
					: [{ caseId: c.caseId, approaches: ["查看错误日志定位问题"], risk: "unknown" as const, estimatedEffort: "30m", references: [] }];
			}
		} else {
			// 无 registry metadata 的用例（如 app-launch）提供默认测试路径
			if (!c.testSteps || c.testSteps.length === 0) {
				c.testSteps = [`执行 spec: ${c.spec || "N/A"}`, `结果: ${c.outcome}`];
			}
		}
	}
}

function detectDeviceModelRuntime(): string {
	try {
		return process.env.E2E_DEVICE_MODEL || (global as any).browser?.capabilities?.deviceModel || "";
	} catch { return ""; }
}

function detectOsVersionRuntime(): string {
	try {
		return process.env.E2E_DEVICE_OS || (global as any).browser?.capabilities?.platformVersion || "";
	} catch { return ""; }
}

/** Merge planned but unexecuted cases from case-registry into the results list. */
function mergePlannedCases(
	executed: CaseRecord[],
	executedIds: Set<string>,
): CaseRecord[] {
	const merged = [...executed];
	const descMap = loadCaseDescriptions();

	function loadRegistry(file: string): void {
		try {
			const registryPath = path.join(e2eDeviceRoot(), file);
			if (fs.existsSync(registryPath)) {
				const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
					cases?: Array<{
						id: string;
						spec?: string;
						name?: string;
						description?: string;
						metadata?: { description?: string; acceptanceCriteria?: string };
					}>;
				};
				for (const c of registry.cases || []) {
					if (!executedIds.has(c.id)) {
						merged.push({
							caseId: c.id,
							spec: c.spec || "",
							title: c.metadata?.description || c.description || c.name || c.id,
							outcome: "skipped",
							issues: [],
							autoFixes: [],
							pendingItems: ["未执行（quick 模式仅跑核心用例）"],
						});
					}
				}
			}
		} catch { /* best-effort */ }
	}

	loadRegistry("case-registry.json");
	loadRegistry("case-registry/device-edge-cases.json");
	return merged;
}

function datePrefixShanghai(): { date: string; hhmm: string } {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).formatToParts(new Date());
	const y = parts.find((p) => p.type === "year")?.value ?? "1970";
	const m = parts.find((p) => p.type === "month")?.value ?? "01";
	const d = parts.find((p) => p.type === "day")?.value ?? "01";
	const h = parts.find((p) => p.type === "hour")?.value ?? "00";
	const min = parts.find((p) => p.type === "minute")?.value ?? "00";
	return { date: `${y}-${m}-${d}`, hhmm: `${h}${min}` };
}

export function resolveGuaziFlowTaskDir(domain?: string): string {
	const root = repoRoot();
	let manifestFlow: string | undefined;
	if (fs.existsSync(paths.projectJson())) {
		try {
			const m = JSON.parse(fs.readFileSync(paths.projectJson(), "utf-8")) as {
				docs?: { guaziFlow?: string };
				pilot?: { domain?: string };
			};
			manifestFlow = m.docs?.guaziFlow;
			domain = domain || m.pilot?.domain;
		} catch (err) {
			if (process.env.E2E_DEBUG) { console.debug("[publish-reports]", err); }
		}
	}

	if (manifestFlow) {
		const dir = path.dirname(path.join(root, manifestFlow));
		if (fs.existsSync(dir)) {
			return path.join(dir, "e2e-device");
		}
	}

	const flowRoot = path.join(root, "docs", "guazi-flow");
	if (fs.existsSync(flowRoot) && domain) {
		const dirs = fs
			.readdirSync(flowRoot, { withFileTypes: true })
			.filter((d) => d.isDirectory() && domain && d.name.includes(domain))
			.map((d) => d.name)
			.sort()
			.reverse();
		if (dirs[0]) {
			return path.join(flowRoot, dirs[0], "e2e-device");
		}
	}

	return path.join(root, "docs", "e2e-device");
}

export interface PublishedReports {
	dest: string;
	archiveFile: string;
	resilienceFile: string;
}

export function publishReports(runId?: string): PublishedReports {
	const { date, hhmm } = datePrefixShanghai();
	const intent = discoverIntent(process.env.E2E_USER_INTENT);
	const dest = resolveGuaziFlowTaskDir(intent.domain);
	fs.mkdirSync(dest, { recursive: true });

	const archiveFile = path.join(dest, `${date}-真机E2E-run-archive-${hhmm}.md`);
	const resilienceFile = path.join(dest, `${date}-真机E2E-resilience-report-${hhmm}.md`);

	let resilienceMd = "";

	const id =
		runId ||
		(fs.existsSync(path.join(e2eDeviceRoot(), RUN_ID_FILE))
			? fs.readFileSync(path.join(e2eDeviceRoot(), RUN_ID_FILE), "utf-8").trim()
			: `run-${Date.now()}`);

	// Resilience report: prefer run-specific, fallback to artifacts root
	const runResilienceSrc = path.join(artifactsRoot(), "runs", id, RESILIENCE_REPORT_JSON);
	const runResilienceMd = path.join(artifactsRoot(), "runs", id, RESILIENCE_REPORT_MD);
	let resilienceSummary: ResilienceRunSummary | undefined;
	let resilienceCases: CaseRecord[] | undefined;
	if (fs.existsSync(runResilienceSrc)) {
		const raw = JSON.parse(fs.readFileSync(runResilienceSrc, "utf-8")) as {
			runId?: string;
			totalCases?: number; passed?: number; passedLive?: number;
			passedWithMock?: number; passedAfterAutofix?: number;
			failed?: number; degradedFailures?: number;
			blockedAuth?: number; skipped?: number; errors?: number;
			autoFixCount?: number; startedAt?: string; finishedAt?: string;
			cases?: CaseRecord[];
		};
		resilienceSummary = {
			runId: raw.runId || id,
			cases: raw.cases || [],
			startedAt: raw.startedAt || "", finishedAt: raw.finishedAt || "",
			totalCases: raw.totalCases || 0, passed: raw.passed || 0,
			passedLive: raw.passedLive || 0, passedWithMock: raw.passedWithMock || 0,
			passedAfterAutofix: raw.passedAfterAutofix || 0, failed: raw.failed || 0,
			degradedFailures: raw.degradedFailures || 0, blockedAuth: raw.blockedAuth || 0,
			skipped: raw.skipped || 0, errors: raw.errors || 0,
			autoFixCount: raw.autoFixCount || 0,
		};
		resilienceCases = raw.cases || [];
		enrichCaseTitles(resilienceCases);

		// Merge planned-but-unexecuted cases from registry
		const executedIds = new Set(resilienceCases.map((c) => c.caseId));
		const merged = mergePlannedCases(resilienceCases, executedIds);
		resilienceSummary.cases = merged;
		resilienceSummary.totalCases = merged.length;
		resilienceSummary.skipped = merged.length - resilienceCases.length;

		resilienceMd = renderResilienceReportZh(resilienceSummary, merged);
	} else if (fs.existsSync(runResilienceMd)) {
		resilienceMd = fs.readFileSync(runResilienceMd, "utf-8");
	}
	if (resilienceMd.trim()) fs.writeFileSync(resilienceFile, resilienceMd, "utf-8");

	const runArchiveJson = path.join(artifactsRoot(), "runs", id, "archive.json");
	let archiveMd = "";
	if (fs.existsSync(runArchiveJson)) {
		const archive = JSON.parse(fs.readFileSync(runArchiveJson, "utf-8")) as {
			runId: string;
			status: string;
			startedAt: string;
			finishedAt?: string;
			sections: {
				resilience: Parameters<typeof renderRunArchiveZh>[0]["summary"];
				issues: Parameters<typeof renderRunArchiveZh>[0]["issues"];
				hybridEvidence?: { mockLayer?: string };
				coverage?: Parameters<typeof renderRunArchiveZh>[0]["coverage"];
			};
		};
		// Load coverage data if not already in archive
		let coverage = archive.sections.coverage;
		let incrementalCoverage = undefined;
		if (!coverage) {
			// Try finalizeing if snapshots exist but haven't been processed yet
			const snapshotsDir = path.join(artifactsRoot(), "runs", id, "coverage-snapshots");
			if (fs.existsSync(snapshotsDir) && fs.readdirSync(snapshotsDir).length > 0) {
				try { finalizeCoverage(id); } catch { /* may already be finalized */ }
			}
			const covResult = loadCoverageResult(id);
			if (covResult.full.enabled) {
				coverage = covResult.full;
				incrementalCoverage = covResult.incremental;
			}
		}
		archiveMd = renderRunArchiveZh({
			runId: archive.runId,
			status: archive.status,
			startedAt: archive.startedAt,
			finishedAt: archive.finishedAt,
			summary: resilienceSummary || {
				runId: archive.runId,
				cases: [],
				startedAt: "", finishedAt: "", totalCases: 0, passed: 0,
				passedLive: 0, passedWithMock: 0, passedAfterAutofix: 0,
				failed: 0, degradedFailures: 0, blockedAuth: 0,
				skipped: 0, errors: 0, autoFixCount: 0,
			},
			issues: archive.sections.issues,
			mockLayer: archive.sections.hybridEvidence?.mockLayer,
			coverage,
			incrementalCoverage,
		});
	} else {
		const legacyMd = path.join(artifactsRoot(), "runs", id, "archive.md");
		if (fs.existsSync(legacyMd)) {
			archiveMd = fs.readFileSync(legacyMd, "utf-8");
		}
	}
	// Skip writing empty reports (e.g. when no cases executed)
	if (archiveMd.trim()) {
		fs.writeFileSync(archiveFile, archiveMd, "utf-8");
	}

	const published: PublishedReports = {
		dest,
		archiveFile,
		resilienceFile,
	};

	if (fs.existsSync(paths.runJson())) {
		try {
			const run = JSON.parse(fs.readFileSync(paths.runJson(), "utf-8")) as Record<
				string,
				unknown
			>;
			run.publishedReports = published;
			fs.writeFileSync(paths.runJson(), JSON.stringify(run, null, 2), "utf-8");
		} catch (err) {
			if (process.env.E2E_DEBUG) { console.debug("[publish-reports]", err); }
		}
	}

	return published;
}
