/**
 * Shared constants used across orchestration, resilience, and scripts.
 *
 * v2: runtime tuning values, status enums, and file-naming constants
 * are consolidated here so every module shares the same vocabulary.
 */

// ============================================================================
// Timeouts & timing (milliseconds)
// ============================================================================

/** Per-case execution timeout (45 s). */
export const CASE_TIMEOUT_MS = 45_000;

/** Pause after app / state reset before the next case (1 s). */
export const RESET_TIMEOUT_MS = 1_000;

/** Appium newCommandTimeout (seconds). */
export const NEW_COMMAND_TIMEOUT = 120;

/** waitFor* default timeout (5 s). */
export const WAITFOR_TIMEOUT = 5_000;

/** Connection retry deadline for Appium / device (120 s). */
export const CONNECTION_RETRY_TIMEOUT = 120_000;

/** How long the user has to confirm a quick-path result (seconds). */
export const QUICK_PATH_CONFIRM_SECONDS = 10;

// ============================================================================
// Profile wall-clock budgets & layered SLOs (ms)
// ============================================================================

/** quick mode hard wall-clock budget. */
export const QUICK_BUDGET_MS = 12 * 60 * 1000;

/** standard mode hard wall-clock budget. */
export const STANDARD_BUDGET_MS = 25 * 60 * 1000;

/** Skip remaining non-P0 segments when cumulative wall reaches this fraction of budget. */
export const BUDGET_SKIP_RATIO = 0.95;

/** Max wall per journey segment spawn (covers multi-case segment). */
export const JOURNEY_SEGMENT_TIMEOUT_MS = 15 * 60 * 1000;

/** Layered prep/boot/warm/infra/post soft SLOs by profile (documentation + telemetry). */
export const LAYER_SLO_MS = {
  quick: {
    prep: 90_000,
    boot: 180_000,
    warm: 8 * 60_000,
    infra: 0,
    post: 60_000,
  },
  standard: {
    prep: 120_000,
    boot: 210_000,
    warm: 18 * 60_000,
    infra: 5 * 60_000,
    post: 90_000,
  },
  resilience: {
    prep: 180_000,
    boot: 300_000,
    warm: 0, // no hard cap
    infra: 10 * 60_000,
    post: 120_000,
  },
} as const;

// ============================================================================
// Test levels & case sources
// ============================================================================

/** Default test level when none is specified. */
export const DEFAULT_TEST_LEVEL = "standard";

/** All recognised test levels. */
export const TEST_LEVELS = ["quick", "standard", "resilience"] as const;
export type TestLevel = (typeof TEST_LEVELS)[number];

/** All recognised case sources. */
export const CASE_SOURCES = ["infra", "biz", "chaos"] as const;
export type CaseSource = (typeof CASE_SOURCES)[number];

// ============================================================================
// Progress statuses
// ============================================================================

export const PROGRESS_STATUSES = [
  "running",
  "passed",
  "failed",
  "timeout",
  "skipped",
  "skipped_auth",
] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

// ============================================================================
// LLM intervention reasons
// ============================================================================

export const LLM_INTERVENTION_REASONS = [
  "ASSERT",
  "LOCATOR",
  "RETRY",
  "DIAGNOSE",
  "NONE",
] as const;
export type LLMInterventionReason = (typeof LLM_INTERVENTION_REASONS)[number];

// ============================================================================
// Concurrency & buffering
// ============================================================================

/** Maximum number of sub-agent processes allowed in parallel. */
export const MAX_PARALLEL_SUBAGENTS = 3;

/** Last-N log lines buffer size for diagnostic snapshots. */
export const LOG_LINES_BUFFER = 5_000;

// ============================================================================
// File / directory naming (backward-compatible with existing orchestration)
// ============================================================================

/** The bootstrap case ID — always runs first (must match discover-cases infra.app-launch). */
export const BOOTSTRAP_CASE_ID = "infra.app-launch";

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

/** Bump to invalidate case-cache and force spec regeneration. */
export const GENERATOR_VERSION = "journey-v2-2-selector-fallback";

/** Journey segment IDs (expert path: env → list → form → infra → chaos). */
export const JOURNEY_SEGMENTS = ["env", "list", "form", "infra", "chaos"] as const;
export type JourneySegmentId = (typeof JOURNEY_SEGMENTS)[number];

/** Default session reset interval for form/list warm segments. */
export const JOURNEY_FORM_RESET_INTERVAL = 12;
