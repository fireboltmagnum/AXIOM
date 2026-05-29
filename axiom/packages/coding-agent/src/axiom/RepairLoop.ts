import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { analyzeFile } from "./CodeAnalyzer.ts";
import { CodeGraphStore } from "./CodeGraphStore.ts";
import { type FailureFingerprintHit, FailureFingerprintStore } from "./FailureFingerprintStore.ts";
import { FlowGraphStore } from "./FlowGraphStore.ts";
import { assessPatchRisk, type PatchRiskReport, type PatchRiskSnapshot } from "./PatchRiskGate.ts";

export const AXIOM_REPAIR_LOOP_TAG = "<axiom_internal_repair_loop>";
export const AXIOM_REPAIR_LOOP_END_TAG = "</axiom_internal_repair_loop>";

export interface RepairVerifier {
	command: string;
	cwd: string;
	reason: string;
	kind: "package-script" | "javascript-test" | "typescript" | "python" | "rust" | "go" | "playwright";
}

export interface RepairIssue {
	file?: string;
	line?: number;
	column?: number;
	message: string;
	kind: "typescript" | "eslint" | "stack" | "python" | "rust" | "go" | "playwright" | "generic";
	owner?: string;
	rankScore?: number;
	rankReasons?: string[];
}

export interface RepairRunResult {
	verifier: RepairVerifier;
	verifierLadder: RepairVerifier[];
	passedVerifiers: RepairVerifier[];
	passed: boolean;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	stdout: string;
	stderr: string;
	issues: RepairIssue[];
	signature: string;
	memoryHints: FailureFingerprintHit[];
	patchRisk: PatchRiskReport;
	packet: string;
}

export interface RepairLoopOptions {
	cwd: string;
	codeGraphStore?: CodeGraphStore;
	failureFingerprintStore?: FailureFingerprintStore;
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
const JS_TEST_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const SOURCE_PACK_RADIUS = 4;
const SOURCE_PACK_LIMIT = 4;
const SOURCE_PACK_MAX_LINE_CHARS = 180;

export function isAxiomRepairLoopText(text: string): boolean {
	return text.trimStart().startsWith(AXIOM_REPAIR_LOOP_TAG);
}

export class RepairLoop {
	private readonly cwd: string;
	private readonly codeGraphStore: CodeGraphStore;
	private readonly failureFingerprintStore: FailureFingerprintStore;
	private readonly flowGraphStore: FlowGraphStore;

	constructor(options: RepairLoopOptions) {
		this.cwd = options.cwd;
		this.codeGraphStore = options.codeGraphStore ?? new CodeGraphStore();
		this.failureFingerprintStore = options.failureFingerprintStore ?? new FailureFingerprintStore();
		this.flowGraphStore = options.flowGraphStore ?? new FlowGraphStore();
	}

	detectVerifier(changedFiles: readonly string[]): RepairVerifier | undefined {
		const files = normalizeChangedFiles(this.cwd, changedFiles).filter((file) =>
			CODE_EXTENSIONS.has(path.extname(file)),
		);
		if (files.length === 0) return undefined;

		const packageDir = findNearestPackageDir(files[0] ? path.dirname(files[0]) : this.cwd, this.cwd);
		if (packageDir) {
			const packageJsonPath = path.join(packageDir, "package.json");
			const scripts = readPackageScripts(packageJsonPath);
			const scriptMap = readPackageScriptMap(packageJsonPath);
			const playwrightVerifier = detectPlaywrightVerifier(packageDir, files, scripts);
			if (playwrightVerifier) return playwrightVerifier;
			const jsTestVerifier = detectJavaScriptTestVerifier(packageDir, files, scriptMap);
			if (jsTestVerifier) return jsTestVerifier;
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

	detectVerifierSequence(changedFiles: readonly string[]): RepairVerifier[] {
		const primary = this.detectVerifier(changedFiles);
		if (!primary) return [];
		const verifiers: RepairVerifier[] = [primary];
		const files = normalizeChangedFiles(this.cwd, changedFiles).filter((file) =>
			CODE_EXTENSIONS.has(path.extname(file)),
		);
		const packageDir = findNearestPackageDir(files[0] ? path.dirname(files[0]) : this.cwd, this.cwd);
		if (packageDir) {
			const scripts = readPackageScripts(path.join(packageDir, "package.json"));
			for (const script of SCRIPT_PRIORITY) {
				if (!scripts.has(script)) continue;
				verifiers.push({
					command: `npm run ${script}`,
					cwd: packageDir,
					reason: `benchmark verifier ladder: package.json script "${script}"`,
					kind: "package-script",
				});
			}
		}
		return uniqueVerifiers(verifiers).slice(0, 3);
	}

	async run(options: {
		changedFiles: readonly string[];
		timeoutMs: number;
		attempt: number;
		maxAttempts: number;
		verifierLadder?: boolean;
		preEditSnapshots?: ReadonlyMap<string, PatchRiskSnapshot>;
	}): Promise<RepairRunResult | undefined> {
		const verifierLadder = options.verifierLadder ? this.detectVerifierSequence(options.changedFiles) : [];
		const primary = this.detectVerifier(options.changedFiles);
		const verifiers = verifierLadder.length > 0 ? verifierLadder : primary ? [primary] : [];
		if (verifiers.length === 0) return undefined;
		const passedVerifiers: RepairVerifier[] = [];
		let lastPassed: RepairRunResult | undefined;
		for (const verifier of verifiers) {
			const result = await this.runSingleVerifier(verifier, {
				...options,
				verifierLadder: verifiers,
				passedVerifiers,
			});
			if (!result.passed) return result;
			passedVerifiers.push(verifier);
			lastPassed = result;
		}
		return lastPassed;
	}

	private async runSingleVerifier(
		verifier: RepairVerifier,
		options: {
			changedFiles: readonly string[];
			timeoutMs: number;
			attempt: number;
			maxAttempts: number;
			verifierLadder: readonly RepairVerifier[];
			passedVerifiers: readonly RepairVerifier[];
			preEditSnapshots?: ReadonlyMap<string, PatchRiskSnapshot>;
		},
	): Promise<RepairRunResult> {
		const startedAt = Date.now();
		const run = await runCommand(verifier.command, verifier.cwd, options.timeoutMs);
		const output = `${run.stdout}\n${run.stderr}`;
		const issues = rankRepairIssues(
			enrichIssues(parseRepairIssues(output, verifier.cwd), verifier.cwd, this.cwd),
			options.changedFiles,
			verifier.cwd,
			this.cwd,
		);
		const verifierPassed = run.exitCode === 0 && !run.timedOut;
		const patchRisk = assessPatchRisk({
			cwd: this.cwd,
			changedFiles: options.changedFiles,
			preEditSnapshots: options.preEditSnapshots,
			verifierPassed,
		});
		const finalIssues =
			verifierPassed && patchRisk.shouldBlock
				? [
						...issues,
						{
							message: `Patch Risk Gate blocked this patch: ${patchRisk.summary}`,
							kind: "generic" as const,
							rankScore: 500,
							rankReasons: ["patch risk gate", patchRisk.level, "verifier passed but patch is risky"],
						},
					]
				: issues;
		const signature = buildSignature(verifier.command, run.exitCode, finalIssues, output, patchRisk);
		const passed = verifierPassed && !patchRisk.shouldBlock;
		const memoryInput = { signature, verifier, issues: finalIssues, changedFiles: options.changedFiles, output };
		const memoryHints = passed ? [] : this.failureFingerprintStore.recall(memoryInput, 3);
		if (!passed) {
			this.failureFingerprintStore.recordFailure(memoryInput);
		}
		const result: RepairRunResult = {
			verifier,
			verifierLadder: [...options.verifierLadder],
			passedVerifiers: [...options.passedVerifiers],
			passed,
			exitCode: run.exitCode,
			timedOut: run.timedOut,
			durationMs: Date.now() - startedAt,
			stdout: tail(run.stdout, 6000),
			stderr: tail(run.stderr, 6000),
			issues: finalIssues,
			signature,
			memoryHints,
			patchRisk,
			packet: "",
		};
		result.packet = this.buildPacket(result, options);
		return result;
	}

	recordSuccessfulRepair(signature: string, changedFiles: readonly string[]): void {
		this.failureFingerprintStore.recordResolution({ signature, changedFiles });
	}

	private buildPacket(
		result: RepairRunResult,
		options: { changedFiles: readonly string[]; attempt: number; maxAttempts: number },
	): string {
		if (result.passed) {
			return [
				AXIOM_REPAIR_LOOP_TAG,
				result.verifierLadder.length > 1
					? `RepairLoop verifier ladder passed: ${result.verifierLadder.map((verifier) => verifier.command).join(" -> ")}`
					: `RepairLoop verifier passed: ${result.verifier.command}`,
				`Duration: ${result.durationMs}ms`,
				AXIOM_REPAIR_LOOP_END_TAG,
			].join("\n");
		}

		const lines: string[] = [];
		lines.push(AXIOM_REPAIR_LOOP_TAG);
		lines.push(
			result.patchRisk.shouldBlock && result.exitCode === 0
				? "AXIOM Patch Risk Gate blocked a risky code edit after the verifier passed."
				: "AXIOM RepairLoop verifier failed after a code edit.",
		);
		lines.push(`Attempt: ${options.attempt}/${options.maxAttempts}`);
		lines.push(`Verifier: ${result.verifier.command}`);
		lines.push(`Reason: ${result.verifier.reason}`);
		if (result.verifierLadder.length > 1) {
			lines.push(`Verifier ladder: ${result.verifierLadder.map((verifier) => verifier.command).join(" -> ")}`);
		}
		if (result.passedVerifiers.length > 0) {
			lines.push(`Passed before failure: ${result.passedVerifiers.map((verifier) => verifier.command).join(", ")}`);
		}
		lines.push(`Exit: ${result.timedOut ? "timeout" : result.exitCode}`);
		lines.push(`Changed files: ${options.changedFiles.map((file) => path.relative(this.cwd, file)).join(", ")}`);
		lines.push("");

		if (result.patchRisk.signals.length > 0) {
			lines.push("Patch Risk Gate:");
			lines.push(
				`- level=${result.patchRisk.level}; score=${result.patchRisk.score}; blocked=${result.patchRisk.shouldBlock}`,
			);
			for (const signal of result.patchRisk.signals.slice(0, 6)) {
				lines.push(
					`- ${signal.severity} ${signal.file}: ${signal.message} ${signal.reason} (+${signal.addedLines}/-${signal.deletedLines})`,
				);
			}
			lines.push("Treat critical/high patch risks as verifier failures even if the command exited 0.");
			lines.push("");
		}

		if (result.issues.length > 0) {
			lines.push("Parsed failures:");
			for (const issue of result.issues.slice(0, 8)) {
				const loc = issue.file
					? `${path.relative(this.cwd, path.resolve(result.verifier.cwd, issue.file))}${issue.line ? `:${issue.line}${issue.column ? `:${issue.column}` : ""}` : ""}`
					: "(unknown location)";
				lines.push(`- ${loc}${issue.owner ? ` in ${issue.owner}` : ""}: ${issue.message}`);
			}
			const ranked = result.issues.filter((issue) => issue.rankReasons && issue.rankReasons.length > 0).slice(0, 4);
			if (ranked.length > 0) {
				lines.push("");
				lines.push("Root-cause priority:");
				for (const issue of ranked) {
					const loc = issue.file
						? `${path.relative(this.cwd, path.resolve(result.verifier.cwd, issue.file))}${issue.line ? `:${issue.line}${issue.column ? `:${issue.column}` : ""}` : ""}`
						: "(unknown location)";
					lines.push(`- ${loc}: score ${issue.rankScore ?? 0}; ${issue.rankReasons?.join(", ")}`);
				}
				lines.push(
					"Focus repair on the highest-ranked failure unless the source context proves it is only a symptom.",
				);
			}
		} else {
			lines.push("Parsed failures: none; inspect stderr/stdout tails below.");
		}

		if (result.memoryHints.length > 0) {
			lines.push("");
			lines.push("FailureFingerprintIndex recalls:");
			for (const hit of result.memoryHints) {
				const entry = hit.entry;
				const resolved = entry.resolvedCount > 0 ? `, resolved ${entry.resolvedCount}x` : "";
				lines.push(
					`- ${entry.id}: seen ${entry.occurrences}x${resolved}; matched ${hit.matched.slice(0, 5).join(", ") || "similar failure"}`,
				);
				for (const hint of entry.repairHints.slice(0, 2)) {
					lines.push(`  hint: ${hint}`);
				}
			}
			lines.push("Use these recalls only if they match the current parsed failure; exact source still wins.");
		}

		const graphHints = this.relatedGraphHints(result.issues);
		if (graphHints.length > 0) {
			lines.push("");
			lines.push("Related graph hints:");
			lines.push(...graphHints.slice(0, 6).map((hint) => `- ${hint}`));
		}

		const sourcePack = buildFailureSourcePack(result.issues, result.verifier.cwd, this.cwd);
		if (sourcePack.length > 0) {
			lines.push("");
			lines.push("Failure Source Pack:");
			lines.push(
				"Exact source around parsed failures. Use these lines first; read more only if the fix requires broader context.",
			);
			lines.push(...sourcePack);
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

function detectJavaScriptTestVerifier(
	packageDir: string,
	files: readonly string[],
	scripts: Map<string, string>,
): RepairVerifier | undefined {
	const target = findTargetedJavaScriptTest(packageDir, files);
	if (!target) return undefined;
	const runner = detectJavaScriptTestRunner(packageDir, scripts);
	const relativeTarget = shellQuote(path.relative(packageDir, target));
	if (runner === "vitest") {
		return {
			command: `npx --no-install vitest run ${relativeTarget} --reporter=verbose`,
			cwd: packageDir,
			reason: "Changed JS/TS test or nearby source file has a targeted Vitest spec",
			kind: "javascript-test",
		};
	}
	if (runner === "jest") {
		return {
			command: `npx --no-install jest ${relativeTarget} --runInBand`,
			cwd: packageDir,
			reason: "Changed JS/TS test or nearby source file has a targeted Jest spec",
			kind: "javascript-test",
		};
	}
	if (runner === "node-test") {
		return {
			command: `node --test ${relativeTarget}`,
			cwd: packageDir,
			reason: "Changed JS/TS test can run with Node's built-in test runner",
			kind: "javascript-test",
		};
	}
	return undefined;
}

function findTargetedJavaScriptTest(packageDir: string, files: readonly string[]): string | undefined {
	for (const file of files) {
		if (!JS_TEST_EXTENSIONS.has(path.extname(file))) continue;
		if (PLAYWRIGHT_SPEC_RE.test(path.basename(file))) return file;
	}
	for (const file of files) {
		if (!JS_TEST_EXTENSIONS.has(path.extname(file))) continue;
		const target = findNearbyJavaScriptTest(packageDir, file);
		if (target) return target;
	}
	return undefined;
}

function findNearbyJavaScriptTest(packageDir: string, sourceFile: string): string | undefined {
	const ext = path.extname(sourceFile);
	const base = sourceFile.slice(0, -ext.length);
	const dir = path.dirname(sourceFile);
	const stem = path.basename(base);
	const candidates = [
		`${base}.test${ext}`,
		`${base}.spec${ext}`,
		path.join(dir, "__tests__", `${stem}.test${ext}`),
		path.join(dir, "__tests__", `${stem}.spec${ext}`),
		path.join(packageDir, "test", path.relative(packageDir, `${base}.test${ext}`)),
		path.join(packageDir, "tests", path.relative(packageDir, `${base}.test${ext}`)),
	].map((candidate) => path.resolve(candidate));
	return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function detectJavaScriptTestRunner(
	packageDir: string,
	scripts: Map<string, string>,
): "vitest" | "jest" | "node-test" | undefined {
	const scriptText = [...scripts.values()].join("\n").toLowerCase();
	if (scriptText.includes("vitest") || hasPackageDependency(packageDir, "vitest")) return "vitest";
	if (scriptText.includes("jest") || hasPackageDependency(packageDir, "jest")) return "jest";
	if (/\bnode\s+--test\b/.test(scriptText)) return "node-test";
	return undefined;
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

function hasPackageDependency(packageDir: string, name: string): boolean {
	try {
		const pkg = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf-8")) as {
			dependencies?: Record<string, unknown>;
			devDependencies?: Record<string, unknown>;
			optionalDependencies?: Record<string, unknown>;
		};
		return (
			name in (pkg.dependencies ?? {}) ||
			name in (pkg.devDependencies ?? {}) ||
			name in (pkg.optionalDependencies ?? {})
		);
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

function rankRepairIssues(
	issues: readonly RepairIssue[],
	changedFiles: readonly string[],
	issueCwd: string,
	rootCwd: string,
): RepairIssue[] {
	const changedAbs = new Set(changedFiles.map((file) => path.resolve(rootCwd, file)));
	const changedBaseNames = new Set([...changedAbs].map((file) => path.basename(file)));
	const fileCounts = countIssueFiles(issues, issueCwd);
	return issues
		.map((issue, index) => {
			const ranked = scoreRepairIssue(issue, {
				index,
				issueCwd,
				rootCwd,
				changedAbs,
				changedBaseNames,
				fileCounts,
			});
			return ranked;
		})
		.sort(
			(a, b) =>
				(b.rankScore ?? 0) - (a.rankScore ?? 0) ||
				(a.line ?? Number.POSITIVE_INFINITY) - (b.line ?? Number.POSITIVE_INFINITY),
		);
}

function countIssueFiles(issues: readonly RepairIssue[], issueCwd: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const issue of issues) {
		if (!issue.file) continue;
		const absolutePath = path.resolve(issueCwd, issue.file);
		counts.set(absolutePath, (counts.get(absolutePath) ?? 0) + 1);
	}
	return counts;
}

function scoreRepairIssue(
	issue: RepairIssue,
	context: {
		index: number;
		issueCwd: string;
		rootCwd: string;
		changedAbs: Set<string>;
		changedBaseNames: Set<string>;
		fileCounts: Map<string, number>;
	},
): RepairIssue {
	let score = Math.max(0, 20 - context.index);
	const reasons: string[] = [];
	if (context.index < 3) reasons.push("early verifier failure");

	if (issue.file) {
		const absolutePath = path.resolve(context.issueCwd, issue.file);
		const relativePath = path.relative(context.rootCwd, absolutePath);
		const basename = path.basename(absolutePath);
		score += 25;
		reasons.push("exact source location");

		if (context.changedAbs.has(absolutePath)) {
			score += 80;
			reasons.push("changed file");
		} else if (context.changedBaseNames.has(basename)) {
			score += 35;
			reasons.push("same basename as changed file");
		}

		if (isLikelySourcePath(relativePath)) {
			score += 15;
			reasons.push("source file");
		}
		if (isLikelyVendorOrBuildPath(relativePath)) {
			score -= 60;
			reasons.push("vendor/build path");
		}
		if (isLikelyTestPath(relativePath) && !context.changedAbs.has(absolutePath)) {
			score -= 8;
			reasons.push("test location may be symptom");
		}
		const fileCount = context.fileCounts.get(absolutePath) ?? 0;
		if (fileCount > 1) {
			score += Math.min(20, fileCount * 4);
			reasons.push(`${fileCount} failures in this file`);
		}
	} else {
		score -= 25;
		reasons.push("no exact source location");
	}

	if (issue.line) {
		score += 5;
		reasons.push("line-specific");
	}
	if (issue.owner) {
		score += 10;
		reasons.push("owning symbol known");
	}

	const kindBonus = repairKindBonus(issue.kind);
	if (kindBonus !== 0) {
		score += kindBonus;
		reasons.push(`${issue.kind} signal`);
	}

	const messageReason = classifyFailureMessage(issue.message);
	if (messageReason) {
		score += messageReason.bonus;
		reasons.push(messageReason.reason);
	}

	return {
		...issue,
		rankScore: score,
		rankReasons: reasons.slice(0, 8),
	};
}

function repairKindBonus(kind: RepairIssue["kind"]): number {
	switch (kind) {
		case "typescript":
		case "python":
		case "rust":
		case "go":
			return 35;
		case "eslint":
			return 25;
		case "stack":
			return 20;
		case "playwright":
			return 10;
		case "generic":
			return 0;
	}
}

function classifyFailureMessage(message: string): { bonus: number; reason: string } | undefined {
	const lower = message.toLowerCase();
	if (/\b(cannot find|not found|no exported member|cannot resolve|module not found|missing import)\b/.test(lower)) {
		return { bonus: 30, reason: "missing symbol/import" };
	}
	if (/\b(unexpected|syntax|parse|unterminated|unclosed|invalid token)\b/.test(lower)) {
		return { bonus: 30, reason: "syntax/parse root cause" };
	}
	if (/\b(undefined|null|cannot read propert|cannot access)\b/.test(lower)) {
		return { bonus: 25, reason: "runtime value root cause" };
	}
	if (/\b(type .* not assignable|is not assignable|property .* does not exist|argument of type)\b/.test(lower)) {
		return { bonus: 20, reason: "type contract mismatch" };
	}
	if (/\b(expected|received|assert|to equal|to be)\b/.test(lower)) {
		return { bonus: 12, reason: "assertion mismatch" };
	}
	if (/\b(timeout|timed out|exceeded)\b/.test(lower)) {
		return { bonus: 8, reason: "timeout/fail-slow signal" };
	}
	return undefined;
}

function isLikelySourcePath(relativePath: string): boolean {
	const normalized = relativePath.split(path.sep).join("/");
	return /(^|\/)(src|lib|app|packages|components|server|client)\//.test(normalized);
}

function isLikelyTestPath(relativePath: string): boolean {
	const normalized = relativePath.split(path.sep).join("/");
	return /(^|\/)(__tests__|test|tests|spec|e2e)\//.test(normalized) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(normalized);
}

function isLikelyVendorOrBuildPath(relativePath: string): boolean {
	const normalized = relativePath.split(path.sep).join("/");
	return /(^|\/)(node_modules|dist|build|coverage|\.next|out|target|vendor)\//.test(normalized);
}

function buildFailureSourcePack(issues: readonly RepairIssue[], issueCwd: string, rootCwd: string): string[] {
	const lines: string[] = [];
	const seen = new Set<string>();
	let emitted = 0;
	for (const issue of issues) {
		if (emitted >= SOURCE_PACK_LIMIT) break;
		if (!issue.file || !issue.line) continue;
		const absolutePath = path.resolve(issueCwd, issue.file);
		const key = `${absolutePath}:${issue.line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (!existsSync(absolutePath)) continue;
		try {
			const stat = statSync(absolutePath);
			if (!stat.isFile()) continue;
			const source = readFileSync(absolutePath, "utf-8");
			if (source.includes("\0")) continue;
			const sourceLines = source.split(/\r?\n/);
			if (issue.line < 1 || issue.line > sourceLines.length) continue;
			const relativePath = path.relative(rootCwd, absolutePath) || issue.file;
			const loc = `${relativePath}:${issue.line}${issue.column ? `:${issue.column}` : ""}`;
			lines.push(`- ${loc}${issue.owner ? ` in ${issue.owner}` : ""}`);
			const nearbySymbols = collectNearbySymbols(relativePath, source, issue.line);
			if (nearbySymbols.length > 0) {
				lines.push(`  nearby symbols: ${nearbySymbols.join(", ")}`);
			}
			lines.push("  ```text");
			lines.push(...formatSourceWindow(sourceLines, issue.line, issue.column));
			lines.push("  ```");
			emitted++;
		} catch {}
	}
	return lines;
}

function collectNearbySymbols(relativePath: string, source: string, line: number): string[] {
	try {
		const understanding = analyzeFile(relativePath, source);
		return [...understanding.symbols]
			.filter((symbol) => Math.abs(symbol.line - line) <= 80)
			.sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line) || a.line - b.line)
			.slice(0, 5)
			.map((symbol) => `${symbol.kind} ${symbol.name}@${symbol.line}`);
	} catch {
		return [];
	}
}

function formatSourceWindow(sourceLines: readonly string[], targetLine: number, column: number | undefined): string[] {
	const start = Math.max(1, targetLine - SOURCE_PACK_RADIUS);
	const end = Math.min(sourceLines.length, targetLine + SOURCE_PACK_RADIUS);
	const width = String(end).length;
	const out: string[] = [];
	for (let lineNumber = start; lineNumber <= end; lineNumber++) {
		const marker = lineNumber === targetLine ? ">" : " ";
		const gutter = String(lineNumber).padStart(width, " ");
		const lineText = truncateSourceLine(sourceLines[lineNumber - 1] ?? "");
		out.push(`  ${marker} ${gutter} | ${lineText}`);
		if (lineNumber === targetLine && column && column > 0 && column <= SOURCE_PACK_MAX_LINE_CHARS) {
			out.push(`    ${" ".repeat(width)} | ${" ".repeat(column - 1)}^`);
		}
	}
	return out;
}

function truncateSourceLine(line: string): string {
	if (line.length <= SOURCE_PACK_MAX_LINE_CHARS) return line;
	return `${line.slice(0, SOURCE_PACK_MAX_LINE_CHARS - 3)}...`;
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

function uniqueVerifiers(verifiers: readonly RepairVerifier[]): RepairVerifier[] {
	const seen = new Set<string>();
	const out: RepairVerifier[] = [];
	for (const verifier of verifiers) {
		const key = `${verifier.cwd}\0${verifier.command}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(verifier);
	}
	return out;
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
	return new Set(readPackageScriptMap(packageJsonPath).keys());
}

function readPackageScriptMap(packageJsonPath: string): Map<string, string> {
	try {
		const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { scripts?: Record<string, unknown> };
		return new Map(
			Object.entries(parsed.scripts ?? {})
				.filter(([, value]) => typeof value === "string")
				.map(([name, value]) => [name, value as string]),
		);
	} catch {
		return new Map();
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
	patchRisk?: PatchRiskReport,
): string {
	const issuePart = issues
		.slice(0, 5)
		.map((issue) => `${issue.file ?? ""}:${issue.line ?? ""}:${issue.column ?? ""}:${issue.message.slice(0, 120)}`)
		.join("|");
	const riskPart =
		patchRisk && patchRisk.signals.length > 0
			? `:risk=${patchRisk.level}:${patchRisk.signals
					.slice(0, 3)
					.map((signal) => `${signal.severity}:${signal.file}:${signal.message}`)
					.join("|")}`
			: "";
	return `${command}:${exitCode}:${issuePart || tail(output, 500)}${riskPart}`;
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
