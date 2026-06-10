import fs from "node:fs";
import path from "node:path";
import { discoverIntent } from "./discover-intent";
import { renderResilienceReportZh, renderRunArchiveZh } from "./render-report-zh";
import { artifactsRoot, e2eDeviceRoot, paths, repoRoot } from "./paths";
import { RUN_ID_FILE, RESILIENCE_REPORT_JSON, RESILIENCE_REPORT_MD } from "./constants";
import { loadCoverageResult } from "./coverage";

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

	const resilienceSrc = path.join(artifactsRoot(), RESILIENCE_REPORT_JSON);
	let resilienceMd = "";
	if (fs.existsSync(resilienceSrc)) {
		const payload = JSON.parse(fs.readFileSync(resilienceSrc, "utf-8")) as {
			summary: Parameters<typeof renderResilienceReportZh>[0];
			records: Parameters<typeof renderResilienceReportZh>[1];
		};
		resilienceMd = renderResilienceReportZh(payload.summary, payload.records);
	} else {
		const legacy = path.join(artifactsRoot(), RESILIENCE_REPORT_MD);
		if (fs.existsSync(legacy)) {
			resilienceMd = fs.readFileSync(legacy, "utf-8");
		}
	}
	// Skip writing empty reports (e.g. when no cases executed)
	if (resilienceMd.trim()) {
		fs.writeFileSync(resilienceFile, resilienceMd, "utf-8");
	}

	const id =
		runId ||
		(fs.existsSync(path.join(e2eDeviceRoot(), RUN_ID_FILE))
			? fs.readFileSync(path.join(e2eDeviceRoot(), RUN_ID_FILE), "utf-8").trim()
			: `run-${Date.now()}`);

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
			summary: archive.sections.resilience,
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
