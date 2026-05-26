import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentTool } from "@axiom/agent-core";
import { Text } from "@axiom/tui";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const playwrightCliSchema = Type.Object({
	action: Type.Union([
		Type.Literal("status"),
		Type.Literal("install"),
		Type.Literal("test"),
		Type.Literal("screenshot"),
		Type.Literal("inspect"),
		Type.Literal("codegen"),
		Type.Literal("show_trace"),
		Type.Literal("show_report"),
	]),
	url: Type.Optional(Type.String({ description: "URL for screenshot/inspect/codegen. Localhost by default." })),
	file: Type.Optional(
		Type.String({ description: "Playwright spec file, trace path, report path, or screenshot output path" }),
	),
	line: Type.Optional(Type.Number({ description: "Optional line number for a Playwright spec" })),
	grep: Type.Optional(Type.String({ description: "Only run tests whose title matches this regex" })),
	project: Type.Optional(Type.String({ description: "Playwright project name, e.g. chromium" })),
	browser: Type.Optional(Type.String({ description: "Browser: chromium, firefox, webkit, or chrome" })),
	target: Type.Optional(Type.String({ description: "For test: all, changed, or last-failed" })),
	trace: Type.Optional(Type.String({ description: "Trace mode: off, on, retain-on-failure, on-first-retry, etc." })),
	reporter: Type.Optional(Type.String({ description: "Reporter for test action, default line" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Tool command timeout in milliseconds" })),
	workers: Type.Optional(Type.Number({ description: "Playwright worker count" })),
	width: Type.Optional(Type.Number({ description: "Screenshot viewport width" })),
	height: Type.Optional(Type.Number({ description: "Screenshot viewport height" })),
	fullPage: Type.Optional(Type.Boolean({ description: "Capture a full-page screenshot" })),
	headed: Type.Optional(Type.Boolean({ description: "Run headed where supported" })),
	debug: Type.Optional(Type.Boolean({ description: "Run Playwright test --debug" })),
	ui: Type.Optional(Type.Boolean({ description: "Run Playwright test --ui" })),
	withDeps: Type.Optional(Type.Boolean({ description: "For install: include OS dependencies" })),
	dryRun: Type.Optional(Type.Boolean({ description: "For install/install-deps: print without changing system" })),
	allowExternal: Type.Optional(Type.Boolean({ description: "Allow non-localhost URLs for browser actions" })),
	interactive: Type.Optional(
		Type.Boolean({ description: "Actually run interactive open/codegen/report/trace actions" }),
	),
});

export type PlaywrightCliToolInput = Static<typeof playwrightCliSchema>;

export interface PlaywrightCliToolDetails {
	action: PlaywrightCliToolInput["action"];
	command?: string;
	exitCode?: number | null;
	timedOut?: boolean;
	durationMs?: number;
	artifactPath?: string;
	hasPlaywright?: boolean;
	hasConfig?: boolean;
}

interface PlaywrightProjectStatus {
	hasPlaywright: boolean;
	hasConfig: boolean;
	hasLocalCli: boolean;
	localCliPath?: string;
	configFiles: string[];
	specFiles: string[];
	packageManagerHint: string;
}

interface CommandSpec {
	command: string;
	args: string[];
	display: string;
	interactive: boolean;
}

function formatPlaywrightCliCall(
	args: PlaywrightCliToolInput | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
): string {
	const action = str(args?.action);
	let text = `${theme.fg("toolTitle", theme.bold("playwright_cli"))} ${
		action === null ? invalidArgText(theme) : theme.fg("accent", action || "")
	}`;
	if (args?.file) text += theme.fg("toolOutput", ` ${shortenPath(args.file)}`);
	if (args?.url) text += theme.fg("toolOutput", ` ${args.url}`);
	if (args?.grep) text += theme.fg("toolOutput", ` grep=${args.grep}`);
	return text;
}

function formatPlaywrightCliResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: PlaywrightCliToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 40;
	const display = lines.slice(0, maxLines).map((line) => theme.fg("toolOutput", line));
	if (lines.length > maxLines) {
		display.push(
			theme.fg("muted", `... (${lines.length - maxLines} more lines, ${keyHint("app.tools.expand", "to expand")})`),
		);
	}
	return `\n${display.join("\n")}`;
}

export function createPlaywrightCliToolDefinition(
	cwd: string,
): ToolDefinition<typeof playwrightCliSchema, PlaywrightCliToolDetails | undefined> {
	return {
		name: "playwright_cli",
		label: "playwright_cli",
		description:
			"Run Playwright browser tests and browser CLI actions with structured output. Use for frontend verification, UI screenshots, trace/report inspection, and browser-facing RepairLoop checks.",
		promptSnippet: "Run Playwright tests, screenshots, traces, and browser verification",
		promptGuidelines: [
			"Use playwright_cli status before assuming Playwright exists in a project.",
			"After frontend/UI edits, prefer playwright_cli test with a specific spec/file/grep before broad test runs.",
			"Use playwright_cli screenshot for localhost UI inspection; external URLs require allowExternal=true and explicit user intent.",
			"Use playwright_cli show_trace/show_report to point at failure artifacts; run interactive viewers only when the user asks.",
			"Never update snapshots from this tool unless the user explicitly requests snapshot updates.",
		],
		parameters: playwrightCliSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: PlaywrightCliToolInput, signal?: AbortSignal) {
			const status = detectPlaywrightProject(cwd);
			if (params.action === "status") {
				return result(params.action, formatStatus(status), {
					hasPlaywright: status.hasPlaywright,
					hasConfig: status.hasConfig,
				});
			}

			const command = buildPlaywrightCommand(params, cwd, status);
			if (command.interactive && !params.interactive) {
				return result(
					params.action,
					[
						`Interactive Playwright action not run: ${command.display}`,
						"Set interactive=true only when an interactive browser/viewer is intended.",
					].join("\n"),
					{ command: command.display, hasPlaywright: status.hasPlaywright, hasConfig: status.hasConfig },
				);
			}

			if (!status.hasPlaywright && params.action !== "install") {
				return result(
					params.action,
					[
						"Playwright is not installed in this project.",
						"Run playwright_cli install browser=chromium, or add @playwright/test to the project first.",
						`Detected command would have been: ${command.display}`,
					].join("\n"),
					{ command: command.display, hasPlaywright: false, hasConfig: status.hasConfig },
				);
			}

			const run = await runCommand(
				command,
				cwd,
				clampTimeout(params.timeoutMs, defaultTimeoutForAction(params.action)),
				signal,
			);
			const text = formatCommandResult(command.display, run, params.action);
			return result(params.action, text, {
				command: command.display,
				exitCode: run.exitCode,
				timedOut: run.timedOut,
				durationMs: run.durationMs,
				artifactPath: command.args.at(-1),
				hasPlaywright: status.hasPlaywright,
				hasConfig: status.hasConfig,
			});
		},
		renderCall(args, theme, _context) {
			return new Text(formatPlaywrightCliCall(args, theme), 0, 0);
		},
		renderResult(toolResult, options, theme, context) {
			const showImages = context.showImages;
			return new Text(formatPlaywrightCliResult(toolResult as any, options, theme, showImages), 0, 0);
		},
	};
}

export function createPlaywrightCliTool(cwd: string): AgentTool<typeof playwrightCliSchema> {
	return wrapToolDefinition(createPlaywrightCliToolDefinition(cwd));
}

export function detectPlaywrightProject(cwd: string): PlaywrightProjectStatus {
	const packageJsonPath = path.join(cwd, "package.json");
	let packageManagerHint = "npm";
	let hasPlaywrightDependency = false;
	if (existsSync(packageJsonPath)) {
		try {
			const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
				packageManager?: string;
				dependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
			};
			const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
			hasPlaywrightDependency = "@playwright/test" in deps || "playwright" in deps;
			packageManagerHint = pkg.packageManager?.split("@")[0] || packageManagerHint;
		} catch {
			// Ignore malformed package.json here; normal project checks will surface it.
		}
	}

	const configFiles = [
		"playwright.config.ts",
		"playwright.config.js",
		"playwright.config.mjs",
		"playwright.config.cjs",
	]
		.map((file) => path.join(cwd, file))
		.filter(existsSync);
	const specFiles = collectSpecFiles(cwd, 25);
	const localCliPath = resolveLocalPlaywrightCli(cwd);
	return {
		hasPlaywright: Boolean(localCliPath || hasPlaywrightDependency || configFiles.length > 0),
		hasConfig: configFiles.length > 0,
		hasLocalCli: Boolean(localCliPath),
		localCliPath,
		configFiles: configFiles.map((file) => path.relative(cwd, file)),
		specFiles: specFiles.map((file) => path.relative(cwd, file)),
		packageManagerHint,
	};
}

export function buildPlaywrightCommand(
	params: PlaywrightCliToolInput,
	cwd: string,
	status: PlaywrightProjectStatus = detectPlaywrightProject(cwd),
): CommandSpec {
	const cli = getCliCommand(params.action, status);
	const args: string[] = [...cli.args];
	let interactive = false;

	switch (params.action) {
		case "install":
			args.push(params.withDeps ? "install" : "install");
			if (params.withDeps) args.push("--with-deps");
			if (params.dryRun) args.push("--dry-run");
			if (params.browser) args.push(params.browser);
			break;
		case "test":
			args.push("test");
			if (params.file) args.push(specTarget(params.file, params.line, cwd));
			if (params.target === "changed") args.push("--only-changed");
			if (params.target === "last-failed") args.push("--last-failed");
			if (params.grep) args.push("--grep", params.grep);
			if (params.project) args.push(`--project=${params.project}`);
			if (params.headed) args.push("--headed");
			if (params.debug) args.push("--debug");
			if (params.ui) {
				args.push("--ui");
				interactive = true;
			}
			if (params.trace) args.push(`--trace=${params.trace}`);
			args.push(`--reporter=${params.reporter ?? "line"}`);
			if (params.workers !== undefined) args.push(`--workers=${Math.max(1, Math.floor(params.workers))}`);
			break;
		case "screenshot": {
			const url = requireLocalUrl(params.url, params.allowExternal);
			const outputPath = resolveScreenshotPath(params.file, cwd);
			args.push("screenshot");
			if (params.browser) args.push(`--browser=${params.browser}`);
			if (params.fullPage) args.push("--full-page");
			if (params.width && params.height)
				args.push(`--viewport-size=${Math.floor(params.width)},${Math.floor(params.height)}`);
			args.push(url, outputPath);
			break;
		}
		case "inspect":
			args.push("open", requireLocalUrl(params.url, params.allowExternal));
			if (params.browser) args.push(`--browser=${params.browser}`);
			if (params.headed) args.push("--headed");
			interactive = true;
			break;
		case "codegen":
			args.push("codegen");
			if (params.browser) args.push(`--browser=${params.browser}`);
			if (params.file) args.push("--output", resolveToCwd(params.file, cwd));
			if (params.url) args.push(requireLocalUrl(params.url, params.allowExternal));
			interactive = true;
			break;
		case "show_trace":
			args.push("show-trace");
			if (params.file) args.push(resolveToCwd(params.file, cwd));
			interactive = true;
			break;
		case "show_report":
			args.push("show-report");
			if (params.file) args.push(resolveToCwd(params.file, cwd));
			interactive = true;
			break;
		case "status":
			break;
	}

	return {
		command: cli.command,
		args,
		display: displayCommand(cli.command, args),
		interactive,
	};
}

function result(
	action: PlaywrightCliToolInput["action"],
	text: string,
	details: Omit<PlaywrightCliToolDetails, "action"> = {},
) {
	return { content: [{ type: "text" as const, text }], details: { action, ...details } };
}

function getCliCommand(
	action: PlaywrightCliToolInput["action"],
	status: PlaywrightProjectStatus,
): { command: string; args: string[] } {
	if (status.localCliPath) return { command: status.localCliPath, args: [] };
	if (action === "install") return { command: "npx", args: ["--yes", "playwright"] };
	return { command: "npx", args: ["--no-install", "playwright"] };
}

function resolveLocalPlaywrightCli(cwd: string): string | undefined {
	const binName = process.platform === "win32" ? "playwright.cmd" : "playwright";
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, "node_modules", ".bin", binName);
		if (existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function collectSpecFiles(cwd: string, limit: number): string[] {
	const out: string[] = [];
	const skip = new Set([".git", ".next", "dist", "node_modules", "playwright-report", "test-results"]);
	const visit = (dir: string) => {
		if (out.length >= limit) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (out.length >= limit) return;
			if (skip.has(entry)) continue;
			const file = path.join(dir, entry);
			let isDirectory = false;
			try {
				const stat = statSync(file);
				isDirectory = stat.isDirectory();
			} catch {
				continue;
			}
			if (isDirectory) visit(file);
			else if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(entry)) out.push(file);
		}
	};
	visit(cwd);
	return out;
}

function formatStatus(status: PlaywrightProjectStatus): string {
	const lines = [
		`Playwright: ${status.hasPlaywright ? "detected" : "not detected"}`,
		`Local CLI: ${status.hasLocalCli ? shortenPath(status.localCliPath ?? "") : "not found"}`,
		`Config: ${status.configFiles.length > 0 ? status.configFiles.join(", ") : "none"}`,
		`Spec files: ${status.specFiles.length}`,
	];
	if (status.specFiles.length > 0) {
		lines.push(...status.specFiles.slice(0, 12).map((file) => `- ${file}`));
	}
	return lines.join("\n");
}

function formatCommandResult(display: string, run: CommandRunResult, action: PlaywrightCliToolInput["action"]): string {
	const lines = [
		`Command: ${display}`,
		`Exit: ${run.timedOut ? "timeout" : run.exitCode}`,
		`Duration: ${run.durationMs}ms`,
	];
	const parsed = action === "test" ? parsePlaywrightFailures(`${run.stdout}\n${run.stderr}`) : [];
	if (parsed.length > 0) {
		lines.push("", "Parsed Playwright failures:", ...parsed.slice(0, 8).map((failure) => `- ${failure}`));
	}
	if (run.stderr.trim()) {
		lines.push("", "stderr:", tail(run.stderr, 4000));
	}
	if (run.stdout.trim()) {
		lines.push("", "stdout:", tail(run.stdout, 6000));
	}
	return lines.join("\n");
}

export function parsePlaywrightFailures(output: string): string[] {
	const failures: string[] = [];
	for (const line of output.split(/\r?\n/)) {
		const testMatch =
			/^\s*\d+\)\s+(?:\[[^\]]+\]\s+›\s+)?(.+?\.(?:spec|test)\.[cm]?[jt]sx?):(\d+):(\d+)\s+›\s+(.+)$/.exec(line);
		if (testMatch) {
			failures.push(`${testMatch[1]}:${testMatch[2]}:${testMatch[3]} ${testMatch[4].trim()}`);
			continue;
		}
		const stackMatch = /^\s+at\s+.+?\((.+?\.[cm]?[jt]sx?):(\d+):(\d+)\)/.exec(line);
		if (stackMatch) {
			failures.push(`${stackMatch[1]}:${stackMatch[2]}:${stackMatch[3]} stack frame`);
			continue;
		}
		if (/^\s*(Error|TimeoutError|AssertionError):/.test(line)) {
			failures.push(line.trim());
		}
	}
	return [...new Set(failures)];
}

function specTarget(file: string, line: number | undefined, cwd: string): string {
	const resolved = resolveToCwd(file, cwd);
	const relative = path.relative(cwd, resolved) || resolved;
	return line ? `${relative}:${Math.floor(line)}` : relative;
}

function resolveScreenshotPath(file: string | undefined, cwd: string): string {
	if (file) return resolveToCwd(file, cwd);
	const dir = path.join(getAgentDir(), "browser-runs", `run_${Date.now()}_${hash(randomUUID(), 8)}`);
	mkdirSync(dir, { recursive: true });
	return path.join(dir, "screenshot.png");
}

function requireLocalUrl(url: string | undefined, allowExternal: boolean | undefined): string {
	if (!url) throw new Error("url is required for this Playwright action");
	if (allowExternal || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(url)) {
		return url;
	}
	throw new Error("External URLs are blocked by default. Set allowExternal=true only when the user explicitly asked.");
}

function defaultTimeoutForAction(action: PlaywrightCliToolInput["action"]): number {
	switch (action) {
		case "test":
			return 120_000;
		case "install":
			return 180_000;
		case "screenshot":
			return 45_000;
		default:
			return 30_000;
	}
}

function clampTimeout(timeoutMs: number | undefined, fallback: number): number {
	if (timeoutMs === undefined) return fallback;
	return Math.max(1000, Math.min(600_000, Math.floor(timeoutMs)));
}

interface CommandRunResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
}

function runCommand(
	command: CommandSpec,
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<CommandRunResult> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const child = spawn(command.command, command.args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const settle = (result: Omit<CommandRunResult, "durationMs">) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ ...result, durationMs: Date.now() - startedAt });
		};
		const onAbort = () => {
			try {
				child.kill("SIGKILL");
			} catch {
				// Process may already have exited.
			}
			settle({ stdout, stderr: `${stderr}\nAborted`, exitCode: null, timedOut });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {
				// Process may already have exited.
			}
		}, timeoutMs);

		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});
		child.on("error", (error) => {
			settle({ stdout, stderr: stderr || error.message, exitCode: null, timedOut });
		});
		child.on("close", (code) => {
			settle({ stdout, stderr, exitCode: code, timedOut });
		});
	});
}

function displayCommand(command: string, args: readonly string[]): string {
	return [command, ...args].map(shellQuoteForDisplay).join(" ");
}

function shellQuoteForDisplay(value: string): string {
	return /^[A-Za-z0-9_./:=,-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function hash(value: string, length: number): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function tail(text: string, maxChars: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return trimmed.slice(trimmed.length - maxChars);
}
