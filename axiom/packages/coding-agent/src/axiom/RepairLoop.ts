import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { analyzeFile } from "./CodeAnalyzer.ts";
import { CodeGraphStore } from "./CodeGraphStore.ts";
import { FlowGraphStore } from "./FlowGraphStore.ts";

export const AXIOM_REPAIR_LOOP_TAG = "<axiom_internal_repair_loop>";
export const AXIOM_REPAIR_LOOP_END_TAG = "</axiom_internal_repair_loop>";

export interface RepairVerifier {
	command: string;
	cwd: string;
	reason: string;
	kind: "package-script" | "typescript" | "python" | "rust" | "go" | "playwright";
}

export interface RepairIssue {
	file?: string;
	line?: number;
	column?: number;
	message: string;
	kind: "typescript" | "eslint" | "stack" | "python" | "rust" | "go" | "playwright" | "generic";
	owner?: string;
}

export interface RepairRunResult {
	verifier: RepairVerifier;
	passed: boolean;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	stdout: string;
	stderr: string;
	issues: RepairIssue[];
	signature: string;
	packet: string;
}

export interface RepairLoopOptions {
	cwd: string;
	codeGraphStore?: CodeGraphStore;
	flowGraphStore?: FlowGraphStore;
}

const SCRIPT_PRIORITY = ["typecheck", "lint", "test", "check"];
const CODE_EXTENSIONS = new Set([
	".c",
	".cc",
	".cpp",
	".css",
	".cs",
	".go",
	".html",
	".java",
	".js",
	".jsx",
	".kt",
	".less",
	".mjs",
	".mts",
	".php",
	".py",
	".rs",
	".sass",
	".scss",
	".svelte",
	".swift",
	".ts",
	".tsx",
	".vue",
]);

const FRONTEND_EXTENSIONS = new Set([".css", ".html", ".jsx", ".less", ".sass", ".scss", ".svelte", ".tsx", ".vue"]);
const PLAYWRIGHT_SCRIPT_PRIORITY = ["test:e2e", "e2e", "test:playwright", "playwright"];
const PLAYWRIGHT_SPEC_RE = /\.(spec|test)\.[cm]?[jt]sx?$/;

export function isAxiomRepairLoopText(text: string): boolean {
	return text.trimStart().startsWith(AXIOM_REPAIR_LOOP_TAG);
}

export class RepairLoop {
	private readonly cwd: string;
	private readonly codeGraphStore: CodeGraphStore;
	private readonly flowGraphStore: FlowGraphStore;

	constructor(options: RepairLoopOptions) {
		this.cwd = options.cwd;
		this.codeGraphStore = options.codeGraphStore ?? new CodeGraphStore();
		this.flowGraphStore = options.flowGraphStore ?? new FlowGraphStore();
	}

	detectVerifier(changedFiles: readonly string[]): RepairVerifier | undefined {
		const files = normalizeChangedFiles(this.cwd, changedFiles).filter((file) =>
			CODE_EXTENSIONS.has(path.extname(file)),
		);
		if (files.length === 0) return undefined;

		const packageDir = findNearestPackageDir(files[0] ? path.dirname(files[0]) : this.cwd, this.cwd);
		if (packageDir) {
			const scripts = readPackageScripts(path.join(packageDir, "package.json"));
			const playwrightVerifier = detectPlaywrightVerifier(packageDir, files, scripts);
			if (playwrightVerifier) return playwrightVerifier;
			for (const script of SCRIPT_PRIORITY) {
				if (scripts.has(script)) {
					return {
						command: `npm run ${script}`,
						cwd: packageDir,
						reason: `package.json script "${script}" is the cheapest available project verifier`,
						kind: "package-script",
					};
				}
			}
		}

		const extensions = new Set(files.map((file) => path.extname(file)));
		if ([...extensions].some((ext) => ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx")) {
			const tsconfigDir = findUp(this.cwd, "tsconfig.json") ?? packageDir;
			if (tsconfigDir) {
				return {
					command: "npx tsc --noEmit",
					cwd: tsconfigDir,
					reason: "TypeScript/JavaScript file changed and tsconfig.json is present",
					kind: "typescript",
				};
			}
		}

		if (extensions.has(".py")) {
			const pyFiles = files
				.filter((file) => path.extname(file) === ".py")
				.map((file) => shellQuote(path.relative(this.cwd, file)));
			const hasPytestConfig = ["pyproject.toml", "pytest.ini", "setup.cfg"].some((name) =>
				existsSync(path.join(this.cwd, name)),
			);
			return {
				command: hasPytestConfig ? "python3 -m pytest -q" : `python3 -m py_compile ${pyFiles.join(" ")}`,
				cwd: this.cwd,
				reason: hasPytestConfig
					? "Python project test config found"
					: "Python files changed; compile changed files",
				kind: "python",
			};
		}

		if (extensions.has(".rs") && existsSync(path.join(this.cwd, "Cargo.toml"))) {
			return { command: "cargo test --quiet", cwd: this.cwd, reason: "Rust file changed", kind: "rust" };
		}

		if (extensions.has(".go") && existsSync(path.join(this.cwd, "go.mod"))) {
			return { command: "go test ./...", cwd: this.cwd, reason: "Go file changed", kind: "go" };
		}

		return undefined;
	}

	async run(options: {
		changedFiles: readonly string[];
		timeoutMs: number;
		attempt: number;
		maxAttempts: number;
	}): Promise<RepairRunResult | undefined> {
		const verifier = this.detectVerifier(options.changedFiles);
		if (!verifier) return undefined;
		const startedAt = Date.now();
		const run = await runCommand(verifier.command, verifier.cwd, options.timeoutMs);
		const output = `${run.stdout}\n${run.stderr}`;
		const issues = enrichIssues(parseRepairIssues(output, verifier.cwd), verifier.cwd, this.cwd);
		const signature = buildSignature(verifier.command, run.exitCode, issues, output);
		const result: RepairRunResult = {
			verifier,
			passed: run.exitCode === 0 && !run.timedOut,
			exitCode: run.exitCode,
			timedOut: run.timedOut,
			durationMs: Date.now() - startedAt,
			stdout: tail(run.stdout, 6000),
			stderr: tail(run.stderr, 6000),
			issues,
			signature,
			packet: "",
		};
		result.packet = this.buildPacket(result, options);
		return result;
	}

	private buildPacket(
		result: RepairRunResult,
		options: { changedFiles: readonly string[]; attempt: number; maxAttempts: number },
	): string {
		if (result.passed) {
			return [
				AXIOM_REPAIR_LOOP_TAG,
				`RepairLoop verifier passed: ${result.verifier.command}`,
				`Duration: ${result.durationMs}ms`,
				AXIOM_REPAIR_LOOP_END_TAG,
			].join("\n");
		}

		const lines: string[] = [];
		lines.push(AXIOM_REPAIR_LOOP_TAG);
		lines.push("AXIOM RepairLoop verifier failed after a code edit.");
		lines.push(`Attempt: ${options.attempt}/${options.maxAttempts}`);
		lines.push(`Verifier: ${result.verifier.command}`);
		lines.push(`Reason: ${result.verifier.reason}`);
		lines.push(`Exit: ${result.timedOut ? "timeout" : result.exitCode}`);
		lines.push(`Changed files: ${options.changedFiles.map((file) => path.relative(this.cwd, file)).join(", ")}`);
		lines.push("");

		if (result.issues.length > 0) {
			lines.push("Parsed failures:");
			for (const issue of result.issues.slice(0, 8)) {
				const loc = issue.file
					? `${path.relative(this.cwd, path.resolve(result.verifier.cwd, issue.file))}${issue.line ? `:${issue.line}${issue.column ? `:${issue.column}` : ""}` : ""}`
					: "(unknown location)";
				lines.push(`- ${loc}${issue.owner ? ` in ${issue.owner}` : ""}: ${issue.message}`);
			}
		} else {
			lines.push("Parsed failures: none; inspect stderr/stdout tails below.");
		}

		const graphHints = this.relatedGraphHints(result.issues);
		if (graphHints.length > 0) {
			lines.push("");
			lines.push("Related graph hints:");
			lines.push(...graphHints.slice(0, 6).map((hint) => `- ${hint}`));
		}

		const stderr = tail(result.stderr, 1600);
		const stdout = tail(result.stdout, 1000);
		if (stderr) {
			lines.push("");
			lines.push("stderr tail:");
			lines.push(stderr);
		}
		if (stdout) {
			lines.push("");
			lines.push("stdout tail:");
			lines.push(stdout);
		}

		lines.push("");
		lines.push(
			"Repair instruction: make the smallest targeted fix for these exact failures. Do not rewrite unrelated code. After editing, let RepairLoop run again.",
		);
		lines.push(AXIOM_REPAIR_LOOP_END_TAG);
		return lines.join("\n");
	}

	private relatedGraphHints(issues: readonly RepairIssue[]): string[] {
		const queries = new Set<string>();
		for (const issue of issues.slice(0, 4)) {
			const parts = [issue.file ? path.basename(issue.file) : "", issue.owner ?? ""].filter(Boolean);
			if (parts.length > 0) queries.add(parts.join(" "));
		}
		const hints: string[] = [];
		for (const query of queries) {
			for (const hit of this.codeGraphStore.search(query, { limit: 1 })) {
				const node = hit.nodes[0];
				if (node) hints.push(`code_graph ${hit.graph.id}: ${node.kind} ${node.label}`);
			}
			for (const hit of this.flowGraphStore.search(query, { limit: 1 })) {
				const node = hit.nodes[0];
				if (node) hints.push(`flow_graph ${hit.graph.id}: ${node.kind} ${node.label}`);
			}
		}
		return [...new Set(hints)];
	}
}

export function parseRepairIssues(output: string, cwd: string): RepairIssue[] {
	const issues: RepairIssue[] = [];
	const lines = output.split(/\r?\n/);
	let eslintFile: string | undefined;
	for (const line of lines) {
		const trimmed = line.trimEnd();
		if (!trimmed) continue;

		if (looksLikePath(trimmed, cwd)) {
			eslintFile = trimmed;
		}

		let match = /^(.+?)\((\d+),(\d+)\):\s+(error\s+TS\d+:\s+.+)$/.exec(trimmed);
		if (match) {
			issues.push(makeIssue(cwd, match[1], match[2], match[3], match[4], "typescript"));
			continue;
		}

		match = /^(.+?):(\d+):(\d+)\s+-\s+(error\s+TS\d+:\s+.+)$/.exec(trimmed);
		if (match) {
			issues.push(makeIssue(cwd, match[1], match[2], match[3], match[4], "typescript"));
			continue;
		}

		match = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+)$/.exec(line);
		if (match && eslintFile) {
			issues.push(makeIssue(cwd, eslintFile, match[1], match[2], `${match[3]} ${match[4]}`, "eslint"));
			continue;
		}

		match = /^\s*at\s+(?:.+?\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(trimmed);
		if (match && !match[1].startsWith("node:")) {
			issues.push(makeIssue(cwd, match[1], match[2], match[3], trimmed, "stack"));
			continue;
		}

		match = /^File "(.+?)", line (\d+)(?:, in (.+))?/.exec(trimmed);
		if (match) {
			issues.push(
				makeIssue(
					cwd,
					match[1],
					match[2],
					undefined,
					match[3] ? `Python traceback in ${match[3]}` : "Python traceback",
					"python",
				),
			);
			continue;
		}

		match = /^\s*-->\s+(.+?):(\d+):(\d+)/.exec(trimmed);
		if (match) {
			issues.push(makeIssue(cwd, match[1], match[2], match[3], "Rust compiler error", "rust"));
			continue;
		}

		match = /^(.+?):(\d+):(\d+):\s+(.+)$/.exec(trimmed);
		if (match && looksLikePath(match[1], cwd)) {
			issues.push(makeIssue(cwd, match[1], match[2], match[3], match[4], "go"));
			continue;
		}

		match = /^\s*\d+\)\s+(?:\[[^\]]+\]\s+›\s+)?(.+?\.(?:spec|test)\.[cm]?[jt]sx?):(\d+):(\d+)\s+›\s+(.+)$/.exec(
			trimmed,
		);
		if (match) {
			issues.push(makeIssue(cwd, match[1], match[2], match[3], `Playwright test failed: ${match[4]}`, "playwright"));
		}
	}
	return dedupeIssues(issues).slice(0, 20);
}

function detectPlaywrightVerifier(
	packageDir: string,
	files: readonly string[],
	scripts: Set<string>,
): RepairVerifier | undefined {
	if (!hasPlaywrightProject(packageDir)) return undefined;
	const specFile = files.find((file) => PLAYWRIGHT_SPEC_RE.test(path.basename(file)));
	const frontendFile = files.find((file) => FRONTEND_EXTENSIONS.has(path.extname(file)));
	if (!specFile && !frontendFile) return undefined;

	const baseArgs = "--project=chromium --reporter=line --max-failures=3 --trace=retain-on-failure";
	if (specFile) {
		return {
			command: `npx --no-install playwright test ${shellQuote(path.relative(packageDir, specFile))} ${baseArgs}`,
			cwd: packageDir,
			reason: "Playwright spec changed; run the targeted browser test first",
			kind: "playwright",
		};
	}

	for (const script of PLAYWRIGHT_SCRIPT_PRIORITY) {
		if (scripts.has(script)) {
			return {
				command: `npm run ${script} -- ${baseArgs}`,
				cwd: packageDir,
				reason: `Frontend file changed and package.json script "${script}" is available`,
				kind: "playwright",
			};
		}
	}

	return {
		command: `npx --no-install playwright test ${baseArgs}`,
		cwd: packageDir,
		reason: "Frontend file changed in a Playwright project; run Chromium browser checks with fail-fast output",
		kind: "playwright",
	};
}

function hasPlaywrightProject(packageDir: string): boolean {
	const configNames = [
		"playwright.config.ts",
		"playwright.config.js",
		"playwright.config.mjs",
		"playwright.config.cjs",
	];
	if (configNames.some((name) => existsSync(path.join(packageDir, name)))) return true;
	try {
		const pkg = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf-8")) as {
			dependencies?: Record<string, unknown>;
			devDependencies?: Record<string, unknown>;
		};
		const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
		return "@playwright/test" in deps || "playwright" in deps;
	} catch {
		return false;
	}
}

function enrichIssues(issues: RepairIssue[], issueCwd: string, rootCwd: string): RepairIssue[] {
	return issues.map((issue) => {
		if (!issue.file || !issue.line) return issue;
		const absolutePath = path.resolve(issueCwd, issue.file);
		if (!existsSync(absolutePath)) return issue;
		try {
			const source = readFileSync(absolutePath, "utf-8");
			const understanding = analyzeFile(path.relative(rootCwd, absolutePath), source);
			const owner = [...understanding.symbols]
				.filter((symbol) => symbol.line <= (issue.line ?? 0))
				.sort((a, b) => b.line - a.line)[0];
			if (!owner) return issue;
			return { ...issue, owner: `${owner.kind} ${owner.name}` };
		} catch {
			return issue;
		}
	});
}

function normalizeChangedFiles(cwd: string, changedFiles: readonly string[]): string[] {
	return [...new Set(changedFiles.map((file) => path.resolve(cwd, file)))].filter((file) => {
		try {
			return existsSync(file) && statSync(file).isFile();
		} catch {
			return false;
		}
	});
}

function findNearestPackageDir(startDir: string, stopDir: string): string | undefined {
	let current = path.resolve(startDir);
	const stop = path.resolve(stopDir);
	while (current.startsWith(stop)) {
		if (existsSync(path.join(current, "package.json"))) return current;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

function findUp(startDir: string, filename: string): string | undefined {
	let current = path.resolve(startDir);
	while (true) {
		if (existsSync(path.join(current, filename))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function readPackageScripts(packageJsonPath: string): Set<string> {
	try {
		const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { scripts?: Record<string, unknown> };
		return new Set(
			Object.entries(parsed.scripts ?? {})
				.filter(([, value]) => typeof value === "string")
				.map(([name]) => name),
		);
	} catch {
		return new Set();
	}
}

function runCommand(
	command: string,
	cwd: string,
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(
			() => {
				timedOut = true;
				child.kill("SIGKILL");
			},
			Math.max(1000, timeoutMs),
		);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ stdout, stderr: stderr || error.message, exitCode: null, timedOut });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, exitCode: code, timedOut });
		});
	});
}

function makeIssue(
	cwd: string,
	file: string,
	line: string | undefined,
	column: string | undefined,
	message: string,
	kind: RepairIssue["kind"],
): RepairIssue {
	const absolute = path.resolve(cwd, file);
	return {
		file: path.relative(cwd, absolute) || file,
		line: line ? Number.parseInt(line, 10) : undefined,
		column: column ? Number.parseInt(column, 10) : undefined,
		message: message.trim(),
		kind,
	};
}

function dedupeIssues(issues: readonly RepairIssue[]): RepairIssue[] {
	const seen = new Set<string>();
	const out: RepairIssue[] = [];
	for (const issue of issues) {
		const key = `${issue.file ?? ""}:${issue.line ?? ""}:${issue.column ?? ""}:${issue.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(issue);
	}
	return out;
}

function buildSignature(
	command: string,
	exitCode: number | null,
	issues: readonly RepairIssue[],
	output: string,
): string {
	const issuePart = issues
		.slice(0, 5)
		.map((issue) => `${issue.file ?? ""}:${issue.line ?? ""}:${issue.column ?? ""}:${issue.message.slice(0, 120)}`)
		.join("|");
	return `${command}:${exitCode}:${issuePart || tail(output, 500)}`;
}

function looksLikePath(value: string, cwd: string): boolean {
	if (value.includes("://")) return false;
	const resolved = path.resolve(cwd, value);
	return existsSync(resolved) || CODE_EXTENSIONS.has(path.extname(value));
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function tail(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text.trim();
	return text.slice(text.length - maxChars).trim();
}
