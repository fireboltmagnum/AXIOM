import type { AgentTool } from "@axiom/agent-core";
import { Text } from "@axiom/tui";
import { type Static, Type } from "typebox";
import type {
	AxiomSparseTreeGrepHit,
	AxiomSparseTreeGrepIndex,
	AxiomSparseTreeGrepNode,
} from "../../axiom/RuntimeTypes.ts";
import { SparseTreeGrepStore } from "../../axiom/SparseTreeGrepStore.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const sparseTreeGrepSchema = Type.Object({
	action: Type.Union([
		Type.Literal("index"),
		Type.Literal("search"),
		Type.Literal("expand"),
		Type.Literal("extract"),
		Type.Literal("stats"),
	]),
	path: Type.Optional(
		Type.String({
			description: "Document path for action=index. Supports text files, and PDFs if pdftotext is installed.",
		}),
	),
	title: Type.Optional(Type.String({ description: "Optional display title for action=index" })),
	query: Type.Optional(Type.String({ description: "Search query for action=search" })),
	documentId: Type.Optional(Type.String({ description: "SparseTreeGrep document id" })),
	nodeId: Type.Optional(Type.String({ description: "Tree node id for action=expand" })),
	chunkId: Type.Optional(Type.String({ description: "Chunk id for action=extract" })),
	around: Type.Optional(Type.Number({ description: "Number of neighboring chunks to include for action=extract" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results/nodes (default 8)" })),
	maxBytes: Type.Optional(Type.Number({ description: "Maximum source bytes to index (default 8000000)" })),
	maxChunks: Type.Optional(Type.Number({ description: "Maximum chunks to index (default 2000)" })),
	extract: Type.Optional(Type.Boolean({ description: "For action=search, include exact text for the top hit" })),
});

export type SparseTreeGrepToolInput = Static<typeof sparseTreeGrepSchema>;

export interface SparseTreeGrepToolDetails {
	action: SparseTreeGrepToolInput["action"];
	documentId?: string;
	chunkCount?: number;
	nodeCount?: number;
}

function formatSparseTreeGrepCall(
	args: SparseTreeGrepToolInput | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
): string {
	const action = str(args?.action);
	const invalidArg = invalidArgText(theme);
	let text = `${theme.fg("toolTitle", theme.bold("SparseTreeGrep"))} ${
		action === null ? invalidArg : theme.fg("accent", action || "")
	}`;
	if (args?.path) text += theme.fg("toolOutput", ` ${shortenPath(args.path)}`);
	if (args?.query) text += theme.fg("toolOutput", ` "${args.query}"`);
	return text;
}

function formatSparseTreeGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: SparseTreeGrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 26;
	const display = lines.slice(0, maxLines).map((line) => theme.fg("toolOutput", line));
	if (lines.length > maxLines) {
		display.push(
			theme.fg("muted", `... (${lines.length - maxLines} more lines, ${keyHint("app.tools.expand", "to expand")})`),
		);
	}
	return `\n${display.join("\n")}`;
}

export function createSparseTreeGrepToolDefinition(
	cwd: string,
): ToolDefinition<typeof sparseTreeGrepSchema, SparseTreeGrepToolDetails | undefined> {
	const store = new SparseTreeGrepStore();
	return {
		name: "sparse_tree_grep",
		label: "SparseTreeGrep",
		description:
			"Index and query non-code documents with an expandable SparseTreeGrep JSON tree. First search lightweight summaries, then expand nodes or extract exact byte-range chunks from the source.",
		promptSnippet: "Index/search/extract non-code documents with SparseTreeGrep",
		promptGuidelines: [
			"Use sparse_tree_grep index for long non-code documents before answering detailed questions about them.",
			"Use sparse_tree_grep search to find candidate pages/chunks cheaply, then sparse_tree_grep extract for exact source text.",
			"Do not use SparseTreeGrep for source code; use read/rg/understand_code for codebases.",
		],
		parameters: sparseTreeGrepSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: SparseTreeGrepToolInput) {
			const action = params.action;
			const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 8)));
			if (action === "index") {
				const index = store.indexDocument({
					path: resolveToCwd(requireParam(params.path, "path"), cwd),
					title: params.title,
					maxBytes: params.maxBytes,
					maxChunks: params.maxChunks,
				});
				return result(action, formatIndex(index, limit), {
					documentId: index.documentId,
					chunkCount: index.chunkCount,
					nodeCount: index.nodes.length,
				});
			}
			if (action === "search") {
				const query = requireParam(params.query, "query");
				const hits = store.search(query, { documentId: params.documentId, limit });
				let text = formatSearch(query, hits);
				if (params.extract && hits[0]) {
					const exact = store.extract(
						hits[0].documentId,
						hits[0].chunkId,
						Math.max(0, Math.floor(params.around ?? 0)),
					);
					text += `\n\n# Exact top hit\n${exact.text}`;
				}
				return result(action, text, {
					documentId: params.documentId,
					chunkCount: hits.length,
				});
			}
			if (action === "expand") {
				const expanded = store.expand(requireParam(params.documentId, "documentId"), params.nodeId, limit);
				return result(action, formatExpand(expanded.nodes, expanded.occurrences), {
					documentId: expanded.index.documentId,
					chunkCount: expanded.occurrences.length,
					nodeCount: expanded.nodes.length,
				});
			}
			if (action === "extract") {
				const exact = store.extract(
					requireParam(params.documentId, "documentId"),
					requireParam(params.chunkId, "chunkId"),
					Math.max(0, Math.floor(params.around ?? 0)),
				);
				return result(action, formatExtract(exact.hit, exact.text), {
					documentId: exact.hit.documentId,
					chunkCount: 1,
				});
			}
			const stats = store.stats();
			const indexes = store.listIndexes();
			return result(action, formatStats(stats, indexes), {
				chunkCount: stats.chunkCount,
				nodeCount: stats.nodeCount,
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSparseTreeGrepCall(args, theme));
			return text;
		},
		renderResult(toolResult, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSparseTreeGrepResult(toolResult as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createSparseTreeGrepTool(cwd: string): AgentTool<typeof sparseTreeGrepSchema> {
	return wrapToolDefinition(createSparseTreeGrepToolDefinition(cwd));
}

function result(
	action: SparseTreeGrepToolInput["action"],
	text: string,
	details: Omit<SparseTreeGrepToolDetails, "action">,
) {
	return {
		content: [{ type: "text" as const, text }],
		details: { action, ...details },
	};
}

function requireParam(value: string | undefined, name: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new Error(`sparse_tree_grep action requires ${name}.`);
	return trimmed;
}

function formatIndex(index: AxiomSparseTreeGrepIndex, limit: number): string {
	const out = [
		`Indexed ${index.documentName}`,
		`documentId: ${index.documentId}`,
		`chunks: ${index.chunkCount}, pages: ${index.pageCount}, nodes: ${index.nodes.length}`,
		`source: ${index.sourcePath}`,
		"",
		"Top expandable nodes:",
	];
	for (const node of index.nodes.filter((candidate) => candidate.level === 0).slice(0, limit)) {
		out.push(`- ${node.id} ${node.label} (${node.occurrenceCount})`);
		out.push(`  ${node.summary}`);
	}
	return out.join("\n");
}

function formatSearch(query: string, hits: AxiomSparseTreeGrepHit[]): string {
	const out = [`Search: ${query}`];
	if (hits.length === 0) {
		out.push("No SparseTreeGrep hits found. Index the document first with action=index.");
		return out.join("\n");
	}
	for (const hit of hits) {
		out.push("");
		out.push(
			`- ${hit.documentName} ${hit.chunkId}${hit.nodeLabel ? ` [${hit.nodeLabel}]` : ""} score ${hit.score.toFixed(2)}`,
		);
		out.push(`  documentId: ${hit.documentId}`);
		out.push(`  page ${hit.page}, lines ${hit.lineStart}-${hit.lineEnd}, bytes ${hit.byteStart}-${hit.byteEnd}`);
		out.push(`  matched: ${hit.matchedKeywords.join(", ")}`);
		out.push(`  ${hit.chunkSummary}`);
	}
	return out.join("\n");
}

function formatExpand(nodes: AxiomSparseTreeGrepNode[], occurrences: AxiomSparseTreeGrepHit[]): string {
	const out = ["Expandable nodes:"];
	if (nodes.length === 0) out.push("- none");
	for (const node of nodes) {
		out.push(`- ${node.id} ${node.label} (${node.occurrenceCount})`);
		out.push(`  ${node.summary}`);
	}
	out.push("");
	out.push("Occurrences:");
	if (occurrences.length === 0) out.push("- none");
	for (const hit of occurrences) {
		out.push(`- ${hit.documentName} ${hit.chunkId}: page ${hit.page}, bytes ${hit.byteStart}-${hit.byteEnd}`);
		out.push(`  ${hit.chunkSummary}`);
	}
	return out.join("\n");
}

function formatExtract(hit: AxiomSparseTreeGrepHit, text: string): string {
	return [
		`Exact extract from ${hit.documentName}`,
		`documentId: ${hit.documentId}`,
		`chunkId: ${hit.chunkId}`,
		`page ${hit.page}, lines ${hit.lineStart}-${hit.lineEnd}, bytes ${hit.byteStart}-${hit.byteEnd}`,
		"",
		text,
	].join("\n");
}

function formatStats(
	stats: { documentCount: number; chunkCount: number; nodeCount: number },
	indexes: AxiomSparseTreeGrepIndex[],
): string {
	const out = [
		`SparseTreeGrep: ${stats.documentCount} document(s), ${stats.chunkCount} chunk(s), ${stats.nodeCount} node(s).`,
		"",
	];
	for (const index of indexes.slice(0, 20)) {
		out.push(`- ${index.documentName} (${index.documentId})`);
		out.push(`  chunks ${index.chunkCount}, pages ${index.pageCount}, source ${shortenPath(index.sourcePath)}`);
	}
	return out.join("\n");
}
