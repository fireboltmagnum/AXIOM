import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { analyzeFile } from "./CodeAnalyzer.ts";

export interface PatchRiskSnapshot {
	existed: boolean;
	content?: string;
}

export interface PatchRiskSignal {
	file: string;
	severity: "low" | "medium" | "high" | "critical";
	message: string;
	reason: string;
	addedLines: number;
	deletedLines: number;
}

export interface PatchRiskReport {
	level: "none" | "low" | "medium" | "high" | "critical";
	score: number;
	shouldBlock: boolean;
	signals: PatchRiskSignal[];
	summary: string;
}

export function assessPatchRisk(input: {
	cwd: string;
	changedFiles: readonly string[];
	preEditSnapshots?: ReadonlyMap<string, PatchRiskSnapshot>;
	verifierPassed: boolean;
}): PatchRiskReport {
	const signals: PatchRiskSignal[] = [];
	for (const file of uniqueAbsPaths(input.cwd, input.changedFiles)) {
		const before = input.preEditSnapshots?.get(file);
		const after = readCurrentSnapshot(file);
		signals.push(...assessFileRisk(input.cwd, file, before, after));
	}
	const score = signals.reduce((total, signal) => total + severityScore(signal.severity), 0);
	const criticalCount = signals.filter((signal) => signal.severity === "critical").length;
	const highCount = signals.filter((signal) => signal.severity === "high").length;
	const destructiveHigh = signals.some(
		(signal) => signal.severity === "high" && /Deleted|deletion-heavy/i.test(signal.message),
	);
	const level = riskLevel(score, criticalCount, highCount);
	const shouldBlock =
		criticalCount > 0 || highCount >= 2 || destructiveHigh || (input.verifierPassed && highCount >= 1 && score >= 55);
	return {
		level,
		score,
		shouldBlock,
		signals: signals.sort((a, b) => severityScore(b.severity) - severityScore(a.severity)),
		summary:
			signals.length === 0
				? "No risky patch patterns detected."
				: `${signals.length} risky patch pattern(s); level=${level}; score=${score}.`,
	};
}

function assessFileRisk(
	cwd: string,
	absolutePath: string,
	before: PatchRiskSnapshot | undefined,
	after: PatchRiskSnapshot,
): PatchRiskSignal[] {
	const file = path.relative(cwd, absolutePath) || absolutePath;
	const signals: PatchRiskSignal[] = [];
	if (!before) return signals;
	const beforeContent = before.content ?? "";
	const afterContent = after.content ?? "";
	const diff = diffLineStats(beforeContent, afterContent);

	if (before.existed && !after.existed) {
		signals.push({
			file,
			severity: isTestPath(file) ? "critical" : "high",
			message: isTestPath(file) ? "Deleted a test file." : "Deleted an existing source file.",
			reason: "Deleting files is a common benchmark failure mode unless explicitly requested.",
			addedLines: 0,
			deletedLines: beforeContent.split(/\r?\n/).length,
		});
		return signals;
	}

	if (!before.existed || !after.existed || beforeContent === afterContent) return signals;

	if (diff.changedRatio >= 0.65 && diff.changedLines >= 80) {
		signals.push({
			file,
			severity: "high",
			message: "Large rewrite detected.",
			reason: "Broad rewrites often introduce regressions and hide the targeted fix.",
			addedLines: diff.addedLines,
			deletedLines: diff.deletedLines,
		});
	}

	if (diff.deletedLines >= 35 && diff.deletedLines > diff.addedLines * 2) {
		signals.push({
			file,
			severity: "high",
			message: "Large deletion-heavy patch detected.",
			reason: "Deletion-heavy fixes can pass narrow tests while removing required behavior.",
			addedLines: diff.addedLines,
			deletedLines: diff.deletedLines,
		});
	}

	if (isTestPath(file)) {
		const removedAssertions =
			countMatches(beforeContent, /\b(expect|assert|should|test|it)\s*[.(]/g) -
			countMatches(afterContent, /\b(expect|assert|should|test|it)\s*[.(]/g);
		if (removedAssertions > 0) {
			signals.push({
				file,
				severity: "critical",
				message: `Removed ${removedAssertions} test/assertion marker(s).`,
				reason: "A coding agent should fix production code, not weaken the test oracle.",
				addedLines: diff.addedLines,
				deletedLines: diff.deletedLines,
			});
		}
		if (/\b(?:it|test|describe)\.only\s*\(|\b(?:it|test|describe)\.skip\s*\(/.test(afterContent)) {
			signals.push({
				file,
				severity: "critical",
				message: "Introduced skipped or exclusive tests.",
				reason: "Skipping tests can fake a passing verifier.",
				addedLines: diff.addedLines,
				deletedLines: diff.deletedLines,
			});
		}
	}

	const removedExports = removedExportedSymbols(file, beforeContent, afterContent);
	if (removedExports.length > 0) {
		signals.push({
			file,
			severity: removedExports.length > 3 ? "high" : "medium",
			message: `Removed exported symbol(s): ${removedExports.slice(0, 6).join(", ")}.`,
			reason: "Removing public surface area is risky unless the task explicitly requires it.",
			addedLines: diff.addedLines,
			deletedLines: diff.deletedLines,
		});
	}

	if (addedStubPattern(beforeContent, afterContent)) {
		signals.push({
			file,
			severity: "high",
			message: "Added stub or not-implemented code.",
			reason: "Stubs often satisfy syntax checks while leaving benchmark behavior broken.",
			addedLines: diff.addedLines,
			deletedLines: diff.deletedLines,
		});
	}

	if (isDependencyOrConfigPath(file) && diff.changedLines >= 20) {
		signals.push({
			file,
			severity: "medium",
			message: "Large dependency/config change detected.",
			reason: "Dependency and config churn can break reproducibility outside the local machine.",
			addedLines: diff.addedLines,
			deletedLines: diff.deletedLines,
		});
	}

	return signals;
}

function readCurrentSnapshot(file: string): PatchRiskSnapshot {
	if (!existsSync(file)) return { existed: false };
	try {
		const stat = statSync(file);
		if (!stat.isFile()) return { existed: false };
		const content = readFileSync(file, "utf-8");
		if (content.includes("\0")) return { existed: true };
		return { existed: true, content };
	} catch {
		return { existed: false };
	}
}

function diffLineStats(
	before: string,
	after: string,
): {
	addedLines: number;
	deletedLines: number;
	changedLines: number;
	changedRatio: number;
} {
	const beforeLines = before.split(/\r?\n/);
	const afterLines = after.split(/\r?\n/);
	let prefix = 0;
	while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix + prefix < beforeLines.length &&
		suffix + prefix < afterLines.length &&
		beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
	) {
		suffix++;
	}
	const deletedLines = Math.max(0, beforeLines.length - prefix - suffix);
	const addedLines = Math.max(0, afterLines.length - prefix - suffix);
	const changedLines = addedLines + deletedLines;
	const baseLines = Math.max(1, beforeLines.length);
	return {
		addedLines,
		deletedLines,
		changedLines,
		changedRatio: changedLines / baseLines,
	};
}

function removedExportedSymbols(file: string, before: string, after: string): string[] {
	try {
		const beforeSymbols = new Set(
			analyzeFile(file, before)
				.symbols.filter((symbol) => symbol.exported)
				.map((symbol) => `${symbol.kind} ${symbol.name}`),
		);
		const afterSymbols = new Set(
			analyzeFile(file, after)
				.symbols.filter((symbol) => symbol.exported)
				.map((symbol) => `${symbol.kind} ${symbol.name}`),
		);
		return [...beforeSymbols].filter((symbol) => !afterSymbols.has(symbol));
	} catch {
		return [];
	}
}

function addedStubPattern(before: string, after: string): boolean {
	const beforeCount = countMatches(before, stubPattern());
	const afterCount = countMatches(after, stubPattern());
	return afterCount > beforeCount;
}

function stubPattern(): RegExp {
	return /\b(TODO|FIXME|not implemented)|throw new Error\(["']not implemented|return null;|return undefined;/gi;
}

function countMatches(text: string, pattern: RegExp): number {
	return [...text.matchAll(pattern)].length;
}

function severityScore(severity: PatchRiskSignal["severity"]): number {
	switch (severity) {
		case "critical":
			return 100;
		case "high":
			return 45;
		case "medium":
			return 20;
		case "low":
			return 5;
	}
}

function riskLevel(score: number, criticalCount: number, highCount: number): PatchRiskReport["level"] {
	if (criticalCount > 0) return "critical";
	if (highCount >= 2 || score >= 70) return "high";
	if (highCount === 1 || score >= 35) return "medium";
	if (score > 0) return "low";
	return "none";
}

function uniqueAbsPaths(cwd: string, files: readonly string[]): string[] {
	return [...new Set(files.map((file) => path.resolve(cwd, file)))];
}

function isTestPath(file: string): boolean {
	const normalized = file.split(path.sep).join("/");
	return /(^|\/)(__tests__|test|tests|spec|e2e)\//.test(normalized) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(normalized);
}

function isDependencyOrConfigPath(file: string): boolean {
	const normalized = file.split(path.sep).join("/");
	return (
		/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|go\.sum)$/.test(normalized) ||
		/(^|\/)(package\.json|tsconfig[^/]*\.json|vite\.config\.[cm]?[jt]s|webpack\.config\.[cm]?[jt]s)$/.test(normalized)
	);
}
