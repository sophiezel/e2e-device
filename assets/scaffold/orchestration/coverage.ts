/**
 * Istanbul 代码覆盖率探测、采集、汇总与报告。
 *
 * 原则：
 * - 零侵入：不要求业务代码额外配置；探测 window.__coverage__ 即可
 * - 增量优先：以 git diff(当前分支 vs main/master) 过滤变更文件，
 *   仅统计本次改动代码的覆盖率，排除 package.json 等非业务文件
 * - 全量兜底：同时保留全量覆盖率作为参考数据写入 raw JSON
 * - 采集时机：每个 spec 切换到 WebView 后探针，spec 结束前采集快照
 * - 聚合：多个 spec 的覆盖率按文件路径合并，各指标取 max(执行次数)
 * - 报告：生成增量+全量两段摘要，嵌入自测归档报告
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { runDir, repoRoot } from "./paths";

// ===== 类型定义 =====

/** Istanbul raw coverage 中的单文件覆盖数据 */
export interface IstanbulFileCoverage {
	path: string;
	statementMap: Record<string, { start: { line: number; column: number }; end: { line: number; column: number } }>;
	fnMap: Record<string, { name: string; decl: { start: { line: number; column: number }; end: { line: number; column: number } }; loc: { start: { line: number; column: number }; end: { line: number; column: number } }; line: number }>;
	branchMap: Record<string, { loc: { start: { line: number; column: number }; end: { line: number; column: number } }; type: string; locations: Array<{ start: { line: number; column: number }; end: { line: number; column: number } }> }>;
	s: Record<string, number>;  // statement hits
	f: Record<string, number>;  // function hits
	b: Record<string, [number, number]>; // branch hits: [taken, total?]
	_coverageSchema?: string;
	hash?: string;
}

/** window.__coverage__ 的完整结构 */
export interface IstanbulRawCoverage {
	[filePath: string]: IstanbulFileCoverage;
}

/** 单文件覆盖率摘要 */
export interface FileCoverageSummary {
	path: string;
	/** 相对项目根路径（短名） */
	shortPath: string;
	/** 是否为增量变更文件 */
	changed: boolean;
	statements: { total: number; covered: number; pct: number };
	branches: { total: number; covered: number; pct: number };
	functions: { total: number; covered: number; pct: number };
	lines: { total: number; covered: number; pct: number };
}

/** 汇总覆盖率摘要 */
export interface CoverageSummary {
	enabled: boolean;
	/** 已采集的总文件数 */
	filesCount: number;
	statements: { total: number; covered: number; pct: number };
	branches: { total: number; covered: number; pct: number };
	functions: { total: number; covered: number; pct: number };
	lines: { total: number; covered: number; pct: number };
	/** 来源：window.__coverage__ | window.__coverage_report__ | none */
	source: string;
	/** 每文件明细 */
	files: FileCoverageSummary[];
}

/** 增量覆盖率（仅 git diff 变更的业务文件） */
export interface IncrementalCoverage {
	enabled: boolean;
	/** base branch */
	base: string;
	/** git diff 变更文件总数（过滤前） */
	totalChangedFiles: number;
	/** 过滤后的业务文件数 */
	businessFiles: number;
	/** 其中在 coverage 里匹配到的文件数 */
	matchedFiles: number;
	/** 增量覆盖率统计 */
	statements: { total: number; covered: number; pct: number };
	branches: { total: number; covered: number; pct: number };
	functions: { total: number; covered: number; pct: number };
	lines: { total: number; covered: number; pct: number };
	/** 变更文件明细（按覆盖率从低到高排列） */
	files: FileCoverageSummary[];
	/** 变更但未被覆盖（或未匹配到 coverage）的文件 */
	uncoveredFiles: string[];
}

// ===== 常量 =====

const COVERAGE_RAW_FILE = "coverage-raw.json";
const COVERAGE_SNAPSHOTS_DIR = "coverage-snapshots";

/** 非业务文件匹配模式——从 git diff 中排除 */
const NON_BUSINESS_PATTERNS: RegExp[] = [
	/package(-lock)?\.json$/,
	/\.lock$/,
	/yarn\.lock$/,
	/pnpm-lock\.yaml$/,
	/tsconfig(\..+)?\.json$/,
	/jsconfig(\..+)?\.json$/,
	/\.eslintrc/i,
	/\.prettierrc/i,
	/\.stylelintrc/i,
	/\.babelrc/i,
	/\.npmrc$/,
	/\.nvmrc$/,
	/\.env(\..+)?$/,
	/\.gitignore$/,
	/\.dockerignore$/,
	/Dockerfile/i,
	/docker-compose/i,
	/nginx\.conf/i,
	/README\.md$/i,
	/CHANGELOG\.md$/i,
	/CONTRIBUTING\.md$/i,
	/LICENSE$/i,
	/\.spec\.(ts|tsx|js|jsx)$/,
	/\.test\.(ts|tsx|js|jsx)$/,
	/__tests__\//,
	/__mocks__\//,
	/\.stories\.(ts|tsx|js|jsx)$/,
	/\.d\.ts$/,
	/\.d\.cts$/,
	/\.d\.mts$/,
	/\.(css|less|scss|sass)$/,  // 样式文件通常不 instrument
	/\.(svg|png|jpg|jpeg|gif|webp|ico)$/,
	/\.(woff2?|ttf|eot)$/,
	/\.html$/,
	/^docs?\//,
	/^\.github\//,
	/^\.vscode\//,
	/^\.idea\//,
	/i18n\//,
	/locales?\//,
	/mock(s)?\//i,               // mock 目录
	/fixtures?\//i,              // fixture 目录
];

// ===== 覆盖率快照文件路径 =====

function coverageSnapshotPath(runId: string, specId: string): string {
	return path.join(runDir(runId), COVERAGE_SNAPSHOTS_DIR, `${specId}.json`);
}

function coverageRawPath(runId: string): string {
	return path.join(runDir(runId), COVERAGE_RAW_FILE);
}

// ===== Git Diff =====

/**
 * 获取当前分支相对于 base 分支的变更文件列表。
 * 按 origin/main → origin/master → main → master 顺序尝试。
 */
export function getGitDiffFiles(base?: string): string[] {
	const root = repoRoot();
	const bases = base ? [base] : ["origin/main", "origin/master", "main", "master"];
	for (const b of bases) {
		try {
			const out = execFileSync("git", ["diff", "--name-only", `${b}...HEAD`], {
				cwd: root,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			const files = out.split("\n").map((f) => f.trim()).filter(Boolean);
			if (files.length > 0) {
				return files;
			}
		} catch {
			// try next base
		}
	}
	return [];
}

/** 获取 base branch 名称（用于报告展示） */
export function getBaseBranch(base?: string): string {
	const bases = base ? [base] : ["origin/main", "origin/master", "main", "master"];
	const root = repoRoot();
	for (const b of bases) {
		try {
			execFileSync("git", ["rev-parse", "--verify", b], {
				cwd: root,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			return b;
		} catch {
			// try next
		}
	}
	return base || "main";
}

/**
 * 过滤非业务文件。
 * 保留 .ts/.tsx/.js/.jsx/.mjs/.cjs/.vue 等源码文件，
 * 排除配置、测试、mock、样式、文档等。
 */
export function filterBusinessFiles(files: string[]): string[] {
	return files.filter((f) => {
		for (const pattern of NON_BUSINESS_PATTERNS) {
			if (pattern.test(f)) return false;
		}
		// 必须包含业务代码扩展名
		const ext = path.extname(f).toLowerCase();
		const businessExts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"];
		return businessExts.includes(ext);
	});
}

// ===== 路径匹配 =====

/**
 * 将 Istanbul coverage 中的文件路径与 git diff 相对路径做匹配。
 *
 * coverage 中的路径可能是：
 *   - 绝对路径：/Users/xxx/project/src/utils/format.ts
 *   - 相对路径：src/utils/format.ts
 *   - webpack:// 前缀路径
 *
 * git diff 路径始终是相对 repo root 如：src/utils/format.ts
 *
 * 匹配策略：去除 coverage 路径的 webpack:// 等前缀后，
 *   取相对于 repo root 的部分与 diff 文件做后缀/包含匹配。
 */
function normalizeCoveragePath(covPath: string): string {
	let p = covPath;

	// 去除 webpack:// 协议前缀
	const webpackIdx = p.indexOf("webpack://");
	if (webpackIdx >= 0) {
		p = p.substring(webpackIdx + "webpack://".length);
		// 去掉 webpack://项目名/./ 前缀
		const dotSlashIdx = p.indexOf("./");
		if (dotSlashIdx >= 0) {
			p = p.substring(dotSlashIdx + 2);
		}
	}

	// 去掉开头的多个 /
	p = p.replace(/^\/+/, "");

	return p;
}

/**
 * 判断 coverage 文件路径是否匹配 diff 中的某个文件。
 */
function matchesDiffFile(covPath: string, diffFile: string): boolean {
	const normalized = normalizeCoveragePath(covPath);

	// 策略 1：精确匹配（normalized 就是 diffFile）
	if (normalized === diffFile) return true;

	// 策略 2：normalized 以 diffFile 结尾（绝对路径情况）
	if (normalized.endsWith("/" + diffFile)) return true;
	if (normalized.endsWith(diffFile)) return true; // diffFile 不含前缀

	// 策略 3：diffFile 以 normalized 结尾
	if (diffFile.endsWith(normalized)) return true;

	// 策略 4：取 coverage 路径最后两段与 diff 最后两段比较
	const covSegs = normalized.split("/");
	const diffSegs = diffFile.split("/");
	const minLen = Math.min(covSegs.length, diffSegs.length, 3);
	if (minLen >= 2) {
		const covTail = covSegs.slice(-minLen).join("/");
		const diffTail = diffSegs.slice(-minLen).join("/");
		if (covTail === diffTail) return true;
	}

	return false;
}

/**
 * 从 full raw coverage 中筛选出与 git diff 变更文件匹配的子集。
 */
function filterCoverageByDiff(
	fullCoverage: IstanbulRawCoverage,
	diffFiles: string[],
): { matched: IstanbulRawCoverage; unmatched: string[] } {
	const matched: IstanbulRawCoverage = {};
	const diffSet = new Set(diffFiles);

	for (const [covPath, data] of Object.entries(fullCoverage)) {
		let found = false;
		for (const df of diffSet) {
			if (matchesDiffFile(covPath, df)) {
				// 用 diff 文件路径作为 key（保证一致性）
				matched[df] = data;
				found = true;
				break;
			}
		}
	}

	// 统计变更但未匹配到的业务文件
	const matchedDiffSet = new Set(Object.keys(matched));
	const unmatched = diffFiles.filter((df) => !matchedDiffSet.has(df));

	return { matched, unmatched };
}

// ===== 探测：是否已引入 Istanbul =====

/**
 * 探测当前 WebView 上下文是否包含 Istanbul 覆盖率数据。
 * 返回探针结果，供 probe-env 和 webview-context 使用。
 */
export async function probeCoverageInWebView(): Promise<{
	hasCoverage: boolean;
	source: string;
}> {
	try {
		const probe = await browser.execute(() => {
			const w = window as unknown as Record<string, unknown>;
			if (w.__coverage__) return "window.__coverage__";
			if (w.__coverage_report__) return "window.__coverage_report__";
			return null;
		});
		if (probe) {
			return { hasCoverage: true, source: probe as string };
		}
	} catch {
		// WebView 不可用时忽略
	}
	return { hasCoverage: false, source: "none" };
}

// ===== 采集：从 WebView 读取 window.__coverage__ =====

/**
 * 从 WebView 中读取 window.__coverage__（或 __coverage_report__ 中的 raw）。
 * 返回原始覆盖率数据，失败时返回 null。
 */
export async function readCoverageFromWebView(): Promise<IstanbulRawCoverage | null> {
	try {
		const data = await browser.execute(() => {
			const w = window as unknown as Record<string, unknown>;
			// 优先取 __coverage_report__ 内嵌的 raw（某些打包器如此）
			const report = w.__coverage_report__ as Record<string, unknown> | undefined;
			if (report && report.raw) {
				return JSON.parse(JSON.stringify(report.raw)) as IstanbulRawCoverage;
			}
			// 否则取 __coverage__
			const cov = w.__coverage__ as IstanbulRawCoverage | undefined;
			if (cov) {
				return JSON.parse(JSON.stringify(cov)) as IstanbulRawCoverage;
			}
			return null;
		});
		return data;
	} catch {
		return null;
	}
}

/**
 * 采集覆盖率快照并落盘到 artifacts/runs/<runId>/coverage-snapshots/<specId>.json
 */
export async function collectCoverageSnapshot(
	runId: string,
	specId: string,
): Promise<{ saved: boolean; filesCount: number }> {
	const cov = await readCoverageFromWebView();
	if (!cov || Object.keys(cov).length === 0) {
		return { saved: false, filesCount: 0 };
	}
	const dir = path.dirname(coverageSnapshotPath(runId, specId));
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(coverageSnapshotPath(runId, specId), JSON.stringify(cov, null, 2), "utf-8");
	return { saved: true, filesCount: Object.keys(cov).length };
}

// ===== 汇总：合并多个快照 + 计算覆盖率 =====

/**
 * 合并两个相同文件的覆盖率数据：各指标取 max(执行次数)。
 */
function mergeFileCoverage(a: IstanbulFileCoverage, b: IstanbulFileCoverage): IstanbulFileCoverage {
	const merged: IstanbulFileCoverage = {
		path: a.path || b.path,
		statementMap: { ...a.statementMap, ...b.statementMap },
		fnMap: { ...a.fnMap, ...b.fnMap },
		branchMap: { ...a.branchMap, ...b.branchMap },
		s: {},
		f: {},
		b: {},
	};

	const allS = new Set([...Object.keys(a.s), ...Object.keys(b.s)]);
	for (const k of allS) {
		merged.s[k] = Math.max(a.s[k] || 0, b.s[k] || 0);
	}

	const allF = new Set([...Object.keys(a.f), ...Object.keys(b.f)]);
	for (const k of allF) {
		merged.f[k] = Math.max(a.f[k] || 0, b.f[k] || 0);
	}

	const allB = new Set([...Object.keys(a.b), ...Object.keys(b.b)]);
	for (const k of allB) {
		const av = a.b[k] || [0, 0];
		const bv = b.b[k] || [0, 0];
		merged.b[k] = [Math.max(av[0], bv[0]), Math.max(av[1] || 0, bv[1] || 0)] as [number, number];
	}

	return merged;
}

/**
 * 从 artifacts/runs/<runId>/coverage-snapshots/ 读取所有快照，
 * 合并为一份 raw coverage，写入 coverage-raw.json。
 * 同时计算 git-diff 增量覆盖率。
 *
 * 返回 { full: 全量摘要, incremental: 增量摘要 }
 */
export function finalizeCoverage(runId: string): {
	full: CoverageSummary;
	incremental: IncrementalCoverage;
} {
	const snapDir = path.join(runDir(runId), COVERAGE_SNAPSHOTS_DIR);

	// 汇总所有快照 → 全量 raw coverage
	const merged: IstanbulRawCoverage = {};
	let snapshotCount = 0;

	if (fs.existsSync(snapDir)) {
		const files = fs.readdirSync(snapDir).filter((f) => f.endsWith(".json"));
		for (const file of files) {
			try {
				const raw = JSON.parse(
					fs.readFileSync(path.join(snapDir, file), "utf-8"),
				) as IstanbulRawCoverage;
				for (const [fp, fc] of Object.entries(raw)) {
					if (merged[fp]) {
						merged[fp] = mergeFileCoverage(merged[fp], fc);
					} else {
						merged[fp] = fc;
					}
				}
				snapshotCount++;
			} catch {
				// 损坏的快照跳过
			}
		}
	}

	// 写入全量 raw 文件
	if (Object.keys(merged).length > 0) {
		const rawPath = coverageRawPath(runId);
		fs.mkdirSync(path.dirname(rawPath), { recursive: true });
		fs.writeFileSync(rawPath, JSON.stringify(merged, null, 2), "utf-8");
	}

	// 全量覆盖率摘要
	const full = computeCoverageSummary(merged, snapshotCount);

	// 增量覆盖率：基于 git diff 过滤
	const incremental = computeIncrementalCoverage(merged);

	return { full, incremental };
}

/**
 * 基于 git diff 变更文件计算增量覆盖率。
 */
function computeIncrementalCoverage(fullCoverage: IstanbulRawCoverage): IncrementalCoverage {
	const base = getBaseBranch();
	const allDiffFiles = getGitDiffFiles(base);
	const businessFiles = filterBusinessFiles(allDiffFiles);

	if (businessFiles.length === 0) {
		return {
			enabled: false,
			base,
			totalChangedFiles: allDiffFiles.length,
			businessFiles: 0,
			matchedFiles: 0,
			statements: { total: 0, covered: 0, pct: 100 },
			branches: { total: 0, covered: 0, pct: 100 },
			functions: { total: 0, covered: 0, pct: 100 },
			lines: { total: 0, covered: 0, pct: 100 },
			files: [],
			uncoveredFiles: [],
		};
	}

	// 从全量 coverage 中筛选变更文件
	const { matched, unmatched } = filterCoverageByDiff(fullCoverage, businessFiles);

	// 计算筛选后 coverage 的摘要
	const incSummary = computeCoverageSummary(
		matched,
		1,
		businessFiles, // 传入 diff 文件用于标记 changed
	);

	return {
		enabled: true,
		base,
		totalChangedFiles: allDiffFiles.length,
		businessFiles: businessFiles.length,
		matchedFiles: incSummary.filesCount,
		statements: incSummary.statements,
		branches: incSummary.branches,
		functions: incSummary.functions,
		lines: incSummary.lines,
		files: incSummary.files,
		uncoveredFiles: unmatched,
	};
}

/**
 * 对 Istanbul raw coverage 进行轻量级计算，输出覆盖率摘要。
 * 不依赖 nyc/istanbul-lib （保持零额外依赖）。
 *
 * @param raw - 原始 coverage 数据
 * @param _snapshotCount - 快照数（未用，保留兼容性）
 * @param diffFiles - 可选，标记哪些文件是 git diff 变更的
 */
function computeCoverageSummary(
	raw: IstanbulRawCoverage,
	_snapshotCount: number,
	diffFiles?: string[],
): CoverageSummary {
	const diffSet = diffFiles ? new Set(diffFiles) : null;
	const files: FileCoverageSummary[] = [];
	const totals = { sTotal: 0, sCovered: 0, bTotal: 0, bCovered: 0, fTotal: 0, fCovered: 0, lTotal: 0, lCovered: 0 };

	for (const [filePath, fc] of Object.entries(raw)) {
		// 判断是否为变更文件
		let changed = false;
		if (diffSet) {
			for (const df of diffSet) {
				if (matchesDiffFile(filePath, df)) {
					changed = true;
					break;
				}
			}
		}

		// Statements
		const sKeys = Object.keys(fc.statementMap || {});
		const sTotal = sKeys.length;
		const sCovered = sKeys.filter((k) => (fc.s[k] || 0) > 0).length;

		// Functions
		const fKeys = Object.keys(fc.fnMap || {});
		const fTotal = fKeys.length;
		const fCovered = fKeys.filter((k) => (fc.f[k] || 0) > 0).length;

		// Branches
		const bKeys = Object.keys(fc.branchMap || {});
		let bTotal = 0;
		let bCovered = 0;
		for (const k of bKeys) {
			const locations = (fc.branchMap[k]?.locations || []).length;
			const hits = fc.b[k] || [];
			bTotal += locations;
			for (let i = 0; i < locations; i++) {
				if ((hits[i] || 0) > 0) bCovered++;
			}
		}

		// Lines (从 statementMap 推导)
		const lineSet = new Set<number>();
		const coveredLineSet = new Set<number>();
		for (const k of sKeys) {
			const sm = fc.statementMap[k];
			if (!sm) continue;
			for (let l = sm.start.line; l <= sm.end.line; l++) {
				lineSet.add(l);
				if ((fc.s[k] || 0) > 0) coveredLineSet.add(l);
			}
		}
		const lTotal = lineSet.size;
		const lCovered = coveredLineSet.size;

		files.push({
			path: filePath,
			shortPath: shortenPath(filePath),
			changed,
			statements: { total: sTotal, covered: sCovered, pct: sTotal > 0 ? roundPct(sCovered / sTotal) : 100 },
			branches: { total: bTotal, covered: bCovered, pct: bTotal > 0 ? roundPct(bCovered / bTotal) : 100 },
			functions: { total: fTotal, covered: fCovered, pct: fTotal > 0 ? roundPct(fCovered / fTotal) : 100 },
			lines: { total: lTotal, covered: lCovered, pct: lTotal > 0 ? roundPct(lCovered / lTotal) : 100 },
		});

		totals.sTotal += sTotal;
		totals.sCovered += sCovered;
		totals.bTotal += bTotal;
		totals.bCovered += bCovered;
		totals.fTotal += fTotal;
		totals.fCovered += fCovered;
		totals.lTotal += lTotal;
		totals.lCovered += lCovered;
	}

	return {
		enabled: Object.keys(raw).length > 0,
		filesCount: files.length,
		statements: { total: totals.sTotal, covered: totals.sCovered, pct: totals.sTotal > 0 ? roundPct(totals.sCovered / totals.sTotal) : 100 },
		branches: { total: totals.bTotal, covered: totals.bCovered, pct: totals.bTotal > 0 ? roundPct(totals.bCovered / totals.bTotal) : 100 },
		functions: { total: totals.fTotal, covered: totals.fCovered, pct: totals.fTotal > 0 ? roundPct(totals.fCovered / totals.fTotal) : 100 },
		lines: { total: totals.lTotal, covered: totals.lCovered, pct: totals.lTotal > 0 ? roundPct(totals.lCovered / totals.lTotal) : 100 },
		source: "window.__coverage__",
		files,
	};
}

function roundPct(v: number): number {
	return Math.round(v * 10000) / 100;
}

/** 缩短路径：去掉 common chunks，保留可读前缀 */
function shortenPath(fp: string): string {
	const markers = ["/src/", "/lib/", "/app/", "/pages/", "/components/", "/utils/", "/services/"];
	for (const m of markers) {
		const idx = fp.indexOf(m);
		if (idx >= 0) {
			return "." + fp.substring(idx);
		}
	}
	const parts = fp.split("/");
	if (parts.length <= 3) return fp;
	return "..." + parts.slice(-2).join("/");
}

// ===== Markdown 报告渲染 =====

/**
 * 渲染覆盖率摘要 Markdown 段（包含增量 + 全量两个表）。
 */
export function renderCoverageMd(summary: CoverageSummary, incremental?: IncrementalCoverage): string {
	if (!summary.enabled) {
		return [
			"",
			"## 📊 代码覆盖率",
			"",
			"⚠️ 未检测到 Istanbul 覆盖率数据（window.`__coverage__` 不可用）。",
			"请在构建时启用 babel-plugin-istanbul 或 vite-plugin-istanbul 以生成覆盖率。",
			"",
		].join("\n");
	}

	const parts: string[] = [
		"",
		"## 📊 代码覆盖率",
		"",
		`> 数据来源：\`${summary.source}\``,
		"",
	];

	// ---- 增量覆盖率（重点） ----
	if (incremental && incremental.enabled) {
		const ic = incremental;
		parts.push(
			"### 🔍 增量覆盖率（git diff vs `" + ic.base + "`）",
			"",
			`> 变更文件：${ic.totalChangedFiles} 个 · 业务文件：${ic.businessFiles} 个 · 匹配到覆盖率：${ic.matchedFiles} 个`,
			"",
			"| 指标 | 已覆盖 | 总数 | 覆盖率 |",
			"|------|--------|------|--------|",
			`| 语句 | ${ic.statements.covered} | ${ic.statements.total} | **${ic.statements.pct}%** |`,
			`| 分支 | ${ic.branches.covered} | ${ic.branches.total} | **${ic.branches.pct}%** |`,
			`| 函数 | ${ic.functions.covered} | ${ic.functions.total} | **${ic.functions.pct}%** |`,
			`| 行 | ${ic.lines.covered} | ${ic.lines.total} | **${ic.lines.pct}%** |`,
			"",
		);

		// 变更文件明细
		if (ic.files.length > 0) {
			// 按覆盖率从低到高排列（突出问题文件）
			const sorted = [...ic.files].sort(
				(a, b) => a.lines.pct - b.lines.pct || a.branches.pct - b.branches.pct,
			);
			parts.push("<details>");
			parts.push("<summary>📁 变更文件覆盖率明细（按覆盖率 ↑）</summary>");
			parts.push("");
			parts.push("| 文件 | 语句% | 分支% | 函数% | 行% |");
			parts.push("|------|-------|-------|-------|------|");
			for (const f of sorted) {
				parts.push(
					`| \`${f.shortPath}\` | ${f.statements.pct}% | ${f.branches.pct}% | ${f.functions.pct}% | ${f.lines.pct}% |`,
				);
			}
			parts.push("", "</details>", "");
		}

		// 变更但未覆盖到的文件（低覆盖率/uncovered 告警）
		if (ic.uncoveredFiles.length > 0) {
			parts.push(
				"<details>",
				"<summary>⚠️ 变更但未采集到覆盖率的业务文件（" + ic.uncoveredFiles.length + " 个）</summary>",
				"",
			);
			for (const f of ic.uncoveredFiles) {
				parts.push(`- \`${f}\``);
			}
			parts.push("", "</details>", "");
		}

		if (ic.lines.pct < 60) {
			parts.push("> ⚠️ **增量代码行覆盖率低于 60%，建议补充测试用例。**", "");
		}
	}

	// ---- 全量覆盖率 ----
	parts.push(
		"<details>",
		"<summary>📦 全量覆盖率（全部 " + summary.filesCount + " 个已插桩文件）</summary>",
		"",
		"| 指标 | 已覆盖 | 总数 | 覆盖率 |",
		"|------|--------|------|--------|",
		`| 语句 | ${summary.statements.covered} | ${summary.statements.total} | **${summary.statements.pct}%** |`,
		`| 分支 | ${summary.branches.covered} | ${summary.branches.total} | **${summary.branches.pct}%** |`,
		`| 函数 | ${summary.functions.covered} | ${summary.functions.total} | **${summary.functions.pct}%** |`,
		`| 行 | ${summary.lines.covered} | ${summary.lines.total} | **${summary.lines.pct}%** |`,
		"",
		"> 原始数据：`artifacts/runs/<runId>/coverage-raw.json`",
		"",
		"</details>",
		"",
	);

	return parts.join("\n");
}

/**
 * 检查当前 run 是否存在覆盖率数据（用于 publish-reports）。
 */
export function hasCoverageData(runId: string): boolean {
	return fs.existsSync(coverageRawPath(runId));
}

/**
 * 加载已合并的覆盖率 raw 数据并返回全量 + 增量摘要（供 publish-reports 用）。
 */
export function loadCoverageResult(runId: string): {
	full: CoverageSummary;
	incremental: IncrementalCoverage;
} {
	const rawPath = coverageRawPath(runId);
	if (!fs.existsSync(rawPath)) {
		const empty: CoverageSummary = {
			enabled: false, filesCount: 0,
			statements: { total: 0, covered: 0, pct: 0 },
			branches: { total: 0, covered: 0, pct: 0 },
			functions: { total: 0, covered: 0, pct: 0 },
			lines: { total: 0, covered: 0, pct: 0 },
			source: "none", files: [],
		};
		const emptyInc: IncrementalCoverage = {
			enabled: false, base: getBaseBranch(),
			totalChangedFiles: 0, businessFiles: 0, matchedFiles: 0,
			statements: { total: 0, covered: 0, pct: 100 },
			branches: { total: 0, covered: 0, pct: 100 },
			functions: { total: 0, covered: 0, pct: 100 },
			lines: { total: 0, covered: 0, pct: 100 },
			files: [], uncoveredFiles: [],
		};
		return { full: empty, incremental: emptyInc };
	}
	try {
		const raw = JSON.parse(fs.readFileSync(rawPath, "utf-8")) as IstanbulRawCoverage;
		const full = computeCoverageSummary(raw, 1);
		const incremental = computeIncrementalCoverage(raw);
		return { full, incremental };
	} catch {
		const empty: CoverageSummary = {
			enabled: false, filesCount: 0,
			statements: { total: 0, covered: 0, pct: 0 },
			branches: { total: 0, covered: 0, pct: 0 },
			functions: { total: 0, covered: 0, pct: 0 },
			lines: { total: 0, covered: 0, pct: 0 },
			source: "error", files: [],
		};
		const emptyInc: IncrementalCoverage = {
			enabled: false, base: getBaseBranch(),
			totalChangedFiles: 0, businessFiles: 0, matchedFiles: 0,
			statements: { total: 0, covered: 0, pct: 100 },
			branches: { total: 0, covered: 0, pct: 100 },
			functions: { total: 0, covered: 0, pct: 100 },
			lines: { total: 0, covered: 0, pct: 100 },
			files: [], uncoveredFiles: [],
		};
		return { full: empty, incremental: emptyInc };
	}
}

// 向后兼容别名
export function loadCoverageSummary(runId: string): CoverageSummary {
	return loadCoverageResult(runId).full;
}
