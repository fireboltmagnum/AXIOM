import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentTool } from "@axiom/agent-core";
import { Text } from "@axiom/tui";
import { type Static, Type } from "typebox";
import { analyzeFile, languageForPath } from "../../axiom/CodeAnalyzer.ts";
import { buildUnderstandingKeywords, CodeUnderstandingStore } from "../../axiom/CodeUnderstandingStore.ts";
import type { AxiomCodeUnderstanding, AxiomFileUnderstanding } from "../../axiom/RuntimeTypes.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const understandCodeSchema = Type.Object({
	path: Type.String({ description: "File or directory to analyze, relative to the current working directory" }),
	recursive: Type.Optional(Type.Boolean({ description: "Recursively scan directories (default: true)" })),
	maxFiles: Type.Optional(Type.Number({ description: "Maximum source files to analyze (default: 60, max: 200)" })),
	maxBytesPerFile: Type.Optional(Type.Number({ description: "Maximum bytes read per file (default: 200000)" })),
});

export type UnderstandCodeToolInput = Static<typeof understandCodeSchema>;

export interface UnderstandCodeToolDetails {
	understandingId: string;
	rootPath: string;
	fileCount: number;
	skippedFiles: number;
	truncatedFiles: number;
}

const DEFAULT_MAX_FILES = 60;
const HARD_MAX_FILES = 200;
const DEFAULT_MAX_BYTES_PER_FILE = 200_000;
const SKIP_DIRS = new Set([
	".axiom",
	".git",
	".next",
	".turbo",
	"build",
	"coverage",
	"dist",
	"node_modules",
	"out",
	"target",
	"vendor",
]);

function formatUnderstandCodeCall(
	args: { path: string; recursive?: boolean; maxFiles?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
): string {
	const rawPath = str(args?.path);
	const invalidArg = invalidArgText(theme);
	let text = `${theme.fg("toolTitle", theme.bold("understand_code"))} ${
		rawPath === null ? invalidArg : theme.fg("accent", shortenPath(rawPath || "."))
	}`;
	if (args?.recursive === false) text += theme.fg("toolOutput", " (shallow)");
	if (args?.maxFiles !== undefined) text += theme.fg("toolOutput", ` (max ${args.maxFiles})`);
	return text;
}

function formatUnderstandCodeResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: UnderstandCodeToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 24;
	const display = lines.slice(0, maxLines).map((line) => theme.fg("toolOutput", line));
	if (lines.length > maxLines) {
		display.push(
			theme.fg("muted", `... (${lines.length - maxLines} more lines, ${keyHint("app.tools.expand", "to expand")})`),
		);
	}
	return `\n${display.join("\n")}`;
}

export function createUnderstandCodeToolDefinition(
	cwd: string,
): ToolDefinition<typeof understandCodeSchema, UnderstandCodeToolDetails | undefined> {
	const store = new CodeUnderstandingStore();
	return {
		name: "understand_code",
		label: "understand_code",
		description:
			"Analyze source files and persist a structured Context Agent understanding of paths, languages, imports, exports, and symbols. Use this before modifying unfamiliar code in rigorous mode.",
		promptSnippet: "Analyze code structure and store Context Agent understandings",
		promptGuidelines: [
			"Use understand_code in rigorous mode when you need a fast map of an unfamiliar file or directory before editing.",
			"Treat understand_code output as a navigation aid; read exact source before making precise edits.",
		],
		parameters: understandCodeSchema,
		executionMode: "sequential",
		async execute(
			_toolCallId,
			{ path: inputPath, recursive = true, maxFiles, maxBytesPerFile }: UnderstandCodeToolInput,
			signal?: AbortSignal,
		) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const rootPath = resolveToCwd(inputPath, cwd);
			if (!existsSync(rootPath)) {
				throw new Error(`Path not found: ${rootPath}`);
			}

			const effectiveMaxFiles = Math.max(1, Math.min(HARD_MAX_FILES, Math.floor(maxFiles ?? DEFAULT_MAX_FILES)));
			const effectiveMaxBytes = Math.max(1_000, Math.floor(maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE));
			const collected = collectSourceFiles(rootPath, {
				recursive,
				maxFiles: effectiveMaxFiles,
				maxBytesPerFile: effectiveMaxBytes,
				signal,
			});

			const files: AxiomFileUnderstanding[] = [];
			let truncatedFiles = 0;
			for (const file of collected.files) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const stat = statSync(file);
				if (stat.size > effectiveMaxBytes) {
					truncatedFiles++;
					continue;
				}
				const source = readFileSync(file, "utf-8");
				files.push(analyzeFile(toPosixPath(path.relative(cwd, file) || file), source));
			}

			const relativeRootPath = toPosixPath(path.relative(cwd, rootPath) || rootPath);
			const understanding: AxiomCodeUnderstanding = {
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				rootPath: relativeRootPath,
				fileCount: files.length,
				files,
				keywords: buildUnderstandingKeywords(relativeRootPath, files),
			};
			const saved = store.save(understanding);
			const details: UnderstandCodeToolDetails = {
				understandingId: understanding.id,
				rootPath: understanding.rootPath,
				fileCount: understanding.fileCount,
				skippedFiles: collected.skipped + truncatedFiles,
				truncatedFiles,
			};

			return {
				content: [{ type: "text", text: formatUnderstandingOutput(understanding, details, saved) }],
				details,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatUnderstandCodeCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatUnderstandCodeResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createUnderstandCodeTool(cwd: string): AgentTool<typeof understandCodeSchema> {
	return wrapToolDefinition(createUnderstandCodeToolDefinition(cwd));
}

function collectSourceFiles(
	rootPath: string,
	options: { recursive: boolean; maxFiles: number; maxBytesPerFile: number; signal?: AbortSignal },
): { files: string[]; skipped: number } {
	const files: string[] = [];
	let skipped = 0;

	const visit = (current: string) => {
		if (options.signal?.aborted) throw new Error("Operation aborted");
		if (files.length >= options.maxFiles) {
			skipped++;
			return;
		}
		const stat = statSync(current);
		if (stat.isDirectory()) {
			const name = path.basename(current);
			if (SKIP_DIRS.has(name)) {
				skipped++;
				return;
			}
			const entries = readdirSync(current).sort();
			for (const entry of entries) {
				const next = path.join(current, entry);
				const nextStat = statSync(next);
				if (nextStat.isDirectory() && !options.recursive) continue;
				visit(next);
				if (files.length >= options.maxFiles) break;
			}
			return;
		}
		if (!stat.isFile()) {
			skipped++;
			return;
		}
		if (languageForPath(current) === "unknown") {
			skipped++;
			return;
		}
		if (stat.size > options.maxBytesPerFile) {
			skipped++;
			return;
		}
		files.push(current);
	};

	visit(rootPath);
	return { files, skipped };
}

function formatUnderstandingOutput(
	understanding: AxiomCodeUnderstanding,
	details: UnderstandCodeToolDetails,
	saved: boolean,
): string {
	const out: string[] = [];
	out.push(`${saved ? "Stored" : "Generated"} code understanding ${understanding.id}`);
	out.push(`Root: ${understanding.rootPath}`);
	out.push(`Files analyzed: ${details.fileCount}${details.skippedFiles ? ` (${details.skippedFiles} skipped)` : ""}`);
	if (understanding.keywords.length > 0) {
		out.push(`Keywords: ${understanding.keywords.slice(0, 30).join(", ")}`);
	}
	out.push("");
	for (const file of understanding.files.slice(0, 20)) {
		const symbolSummary = file.symbols
			.slice(0, 10)
			.map((symbol) => `${symbol.kind} ${symbol.name}@${symbol.line}`)
			.join(", ");
		out.push(`- ${file.path} (${file.language}, ${file.lineCount} lines)`);
		if (file.imports.length > 0) out.push(`  imports: ${file.imports.slice(0, 8).join(", ")}`);
		if (file.exports.length > 0) out.push(`  exports: ${file.exports.slice(0, 8).join(", ")}`);
		if (symbolSummary) out.push(`  symbols: ${symbolSummary}`);
	}
	if (understanding.files.length > 20) {
		out.push(`... ${understanding.files.length - 20} more analyzed file(s) persisted in Context Agent storage.`);
	}
	return out.join("\n");
}

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}
