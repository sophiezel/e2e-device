/**
 * Lightweight structured logger for e2e-device.
 * Outputs formatted logs to console and optionally to a file.
 */
import fs from "node:fs";
import path from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

interface Logger {
	debug(message: string, data?: Record<string, unknown>): void;
	info(message: string, data?: Record<string, unknown>): void;
	warn(message: string, data?: Record<string, unknown>): void;
	error(message: string, data?: Record<string, unknown>): void;
	/** Log a structured JSON event for CI parsing */
	event(type: string, data: Record<string, unknown>): void;
}

function getLogDir(): string | null {
	return process.env.E2E_LOG_DIR || null;
}

function ensureLogDir(dir: string): void {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function appendToLog(line: string): void {
	const dir = getLogDir();
	if (!dir) return;
	ensureLogDir(dir);
	fs.appendFileSync(path.join(dir, "run.log"), line + "\n", "utf-8");
}

function formatLine(level: LogLevel, namespace: string, message: string): string {
	const ts = new Date().toISOString();
	return `[${ts}] [${namespace}] ${level.toUpperCase()} ${message}`;
}

export function createLogger(namespace: string): Logger {
	function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
		const line = formatLine(level, namespace, message);
		const output = data ? `${line} ${JSON.stringify(data)}` : line;

		switch (level) {
			case "error":
				console.error(output);
				break;
			case "warn":
				console.warn(output);
				break;
			default:
				console.log(output);
		}

		appendToLog(output);
	}

	return {
		debug: (message, data) => log("debug", message, data),
		info: (message, data) => log("info", message, data),
		warn: (message, data) => log("warn", message, data),
		error: (message, data) => log("error", message, data),
		event: (type, data) => {
			const ts = new Date().toISOString();
			const jsonLine = JSON.stringify({ ts, type, namespace, ...data });
			console.log(jsonLine);
			appendToLog(jsonLine);
		},
	};
}
