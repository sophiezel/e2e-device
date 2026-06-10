/** Shared constants used across orchestration, resilience, and scripts. */

/** The bootstrap case ID — always runs first. */
export const BOOTSTRAP_CASE_ID = "00-bootstrap";

/** Filename for persisting the current run ID. */
export const RUN_ID_FILE = ".e2e-run-id";

/** Filename for the sequential execution audit trail. */
export const CASES_EXECUTED_FILE = "cases-executed.jsonl";

/** Filename for run metadata. */
export const RUN_META_FILE = "run-meta.json";

/** Filename for resilience report JSON. */
export const RESILIENCE_REPORT_JSON = "resilience-report.json";

/** Filename for resilience report Markdown. */
export const RESILIENCE_REPORT_MD = "resilience-report.md";

/** Filename for run archive JSON. */
export const ARCHIVE_JSON = "archive.json";

/** Filename for run archive Markdown. */
export const ARCHIVE_MD = "archive.md";

/** Filename for merged coverage raw JSON. */
export const COVERAGE_RAW_FILE = "coverage-raw.json";

/** Directory name for per-spec coverage snapshots. */
export const COVERAGE_SNAPSHOTS_DIR = "coverage-snapshots";
