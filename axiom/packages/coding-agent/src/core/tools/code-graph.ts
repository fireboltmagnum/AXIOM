import type { AgentTool } from "@axiom/agent-core";
import { Text } from "@axiom/tui";
import { type Static, Type } from "typebox";
import { type CodeGraphPathResult, CodeGraphStore } from "../../axiom/CodeGraphStore.ts";
import type { AxiomCodeGraph, AxiomCodeGraphEdge, AxiomCodeGraphHit } from "../../axiom/RuntimeTypes.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const codeGraphSchema = Type.Object({
	action: Type.Union([
		Type.Literal("index"),
		Type.Literal("search"),
		Type.Literal("neighbors"),
		Type.Literal("path"),
		Type.Literal("stats"),
	]),
	path: Type.Optional(Type.String({ description: "File or directory for action=index" })),
	query: Type.Optional(Type.String({ description: "Search query for action=search" })),
	graphId: Type.Optional(Type.String({ description: "Specific code graph id to query" })),
	node: Type.Optional(Type.String({ description: "Node label, file path, or node id for action=neighbors" })),
	from: Type.Optional(Type.String({ description: "Start node label, file path, or node id for action=path" })),
	to: Type.Optional(Type.String({ description: "Target node label, file path, or node id for action=path" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results/edges (default 8)" })),
	maxDepth: Type.Optional(Type.Number({ description: "Maximum path depth (default 5)" })),
	maxFiles: Type.Optional(Type.Number({ description: "Maximum source files to index (default 250, max 1000)" })),
	maxBytesPerFile: Type.Optional(Type.Number({ description: "Maximum bytes read from each source file" })),
});

export type CodeGraphToolInput = Static<typeof codeGraphSchema>;

export interface CodeGraphToolDetails {
	action: CodeGraphToolInput["action"];
	graphId?: string;
	fileCount?: number;
	nodeCount?: number;
	edgeCount?: number;
}

function formatCodeGraphCall(
	args: CodeGraphToolInput | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
): string {
	const action = str(args?.action);
	const invalidArg = invalidArgText(theme);
	let text = `${theme.fg("toolTitle", theme.bold("code_graph"))} ${
		action === null ? invalidArg : theme.fg("accent", action || "")
	}`;
	if (args?.path) text += theme.fg("toolOutput", ` ${shortenPath(args.path)}`);
	if (args?.query) text += theme.fg("toolOutput", ` "${args.query}"`);
	if (args?.node) text += theme.fg("toolOutput", ` ${args.node}`);
	if (args?.from && args?.to) text += theme.fg("toolOutput", ` ${args.from} -> ${args.to}`);
	return text;
}

function formatCodeGraphResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: CodeGraphToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 28;
	const display = lines.slice(0, maxLines).map((line) => theme.fg("toolOutput", line));
	if (lines.length > maxLines) {
		display.push(
			theme.fg("muted", `... (${lines.length - maxLines} more lines, ${keyHint("app.tools.expand", "to expand")})`),
		);
	}
	return `\n${display.join("\n")}`;
}

export function createCodeGraphToolDefinition(
	cwd: string,
): ToolDefinition<typeof codeGraphSchema, CodeGraphToolDetails | undefined> {
	const store = new CodeGraphStore();
	return {
		name: "code_graph",
		label: "code_graph",
		description:
			"Build and query a Graphify-style codebase graph of files, symbols, imports, exports, and containment relationships. Use in rigorous mode when codebase relationships matter.",
		promptSnippet: "Build/query Graphify-style codebase relationship graph",
		promptGuidelines: [
			"Use code_graph action=index in rigorous mode for unfamiliar repositories when file/symbol/import relationships matter.",
			"Use code_graph search/neighbors/path to answer dependency, ownership, or symbol-relationship questions after indexing.",
			"Use understand_code for per-file summaries; use code_graph for cross-file graph relationships.",
			"Do not use code_graph for non-code documents; use SparseTreeGrep for documents and knowledge_graph for durable facts.",
		],
		parameters: codeGraphSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: CodeGraphToolInput) {
			const action = params.action;
			const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 8)));

			if (action === "index") {
				const graph = store.index({
					path: resolveToCwd(requireParam(params.path, "path"), cwd),
					maxFiles: params.maxFiles,
					maxBytesPerFile: params.maxBytesPerFile,
				});
				return result(action, formatIndex(graph, limit), graph);
			}

			if (action === "search") {
				const query = requireParam(params.query, "query");
				const hits = store.search(query, { graphId: params.graphId, limit });
				return result(action, formatHits(`Search: ${query}`, hits), hits[0]?.graph);
			}

			if (action === "neighbors") {
				const graphId = requireParam(params.graphId, "graphId");
				const node = requireParam(params.node ?? params.query, "node");
				const hit = store.neighbors(graphId, node, limit);
				const text = hit ? formatHits(`Neighbors: ${node}`, [hit]) : `No code graph node found for: ${node}`;
				return result(action, text, hit?.graph ?? store.load(graphId));
			}

			if (action === "path") {
				const graphId = requireParam(params.graphId, "graphId");
				const from = requireParam(params.from, "from");
				const to = requireParam(params.to, "to");
				const pathResult = store.path(
					graphId,
					from,
					to,
					Math.max(1, Math.min(10, Math.floor(params.maxDepth ?? 5))),
				);
				const text = pathResult
					? formatPath(from, to, pathResult)
					: `No code graph path found from ${from} to ${to}.`;
				return result(action, text, pathResult?.graph ?? store.load(graphId));
			}

			const stats = store.stats();
			return {
				content: [{ type: "text" as const, text: formatStats(stats, store.list()) }],
				details: {
					action,
					fileCount: stats.fileCount,
					nodeCount: stats.nodeCount,
					edgeCount: stats.edgeCount,
				},
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatCodeGraphCall(args, theme));
			return text;
		},
		renderResult(toolResult, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatCodeGraphResult(toolResult as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createCodeGraphTool(cwd: string): AgentTool<typeof codeGraphSchema> {
	return wrapToolDefinition(createCodeGraphToolDefinition(cwd));
}

function result(action: CodeGraphToolInput["action"], text: string, graph: AxiomCodeGraph | undefined) {
	return {
		content: [{ type: "text" as const, text }],
		details: {
			action,
			graphId: graph?.id,
			fileCount: graph?.fileCount,
			nodeCount: graph?.nodeCount,
			edgeCount: graph?.edgeCount,
		},
	};
}

function requireParam(value: string | undefined, name: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new Error(`code_graph action requires ${name}.`);
	return trimmed;
}

function formatIndex(graph: AxiomCodeGraph, limit: number): string {
	const out = [
		`Indexed code graph ${graph.id}`,
		`Root: ${graph.rootPath}`,
		`Files: ${graph.fileCount}, nodes: ${graph.nodeCount}, edges: ${graph.edgeCount}`,
		"",
		"Files:",
	];
	for (const file of graph.nodes.filter((node) => node.kind === "file").slice(0, limit)) {
		const symbols = graph.edges
			.filter((edge) => edge.kind === "contains" && edge.fromId === file.id)
			.map((edge) => graph.nodes.find((node) => node.id === edge.toId))
			.filter((node): node is AxiomCodeGraph["nodes"][number] => node !== undefined)
			.slice(0, 6)
			.map((node) => `${node.symbolKind ?? "symbol"} ${node.label}${node.line ? `@${node.line}` : ""}`)
			.join(", ");
		out.push(`- ${file.path ?? file.label}${symbols ? ` (${symbols})` : ""}`);
	}
	out.push("");
	out.push("Imports:");
	const importEdges = graph.edges.filter((edge) => edge.kind === "imports").slice(0, limit);
	if (importEdges.length === 0) out.push("- none");
	for (const edge of importEdges) {
		out.push(`- ${formatEdge(edge, graph)}`);
	}
	return out.join("\n");
}

function formatHits(title: string, hits: AxiomCodeGraphHit[]): string {
	const out = [title];
	if (hits.length === 0) {
		out.push("No code graph hits found. Index the codebase first with action=index.");
		return out.join("\n");
	}
	for (const hit of hits) {
		const primary = hit.nodes[0];
		out.push("");
		out.push(
			`Score ${hit.score.toFixed(2)} in ${hit.graph.rootPath}${hit.matchedKeywords.length ? `, matched: ${hit.matchedKeywords.join(", ")}` : ""}`,
		);
		if (primary) {
			out.push(`Primary: ${primary.label} (${primary.kind}${primary.path ? `, ${primary.path}` : ""})`);
		}
		for (const edge of hit.edges.slice(0, 12)) {
			out.push(`- ${formatEdge(edge, hit.graph)}`);
		}
	}
	return out.join("\n");
}

function formatPath(from: string, to: string, pathResult: CodeGraphPathResult): string {
	const out = [`Path: ${from} -> ${to}`, `Graph: ${pathResult.graph.id} (${pathResult.graph.rootPath})`];
	if (pathResult.edges.length === 0) {
		out.push("- same node");
		return out.join("\n");
	}
	for (const edge of pathResult.edges) {
		out.push(`- ${formatEdge(edge, pathResult.graph)}`);
	}
	return out.join("\n");
}

function formatStats(
	stats: { graphCount: number; fileCount: number; nodeCount: number; edgeCount: number },
	graphs: AxiomCodeGraph[],
): string {
	const out = [
		`Code graphs: ${stats.graphCount}`,
		`Files: ${stats.fileCount}, nodes: ${stats.nodeCount}, edges: ${stats.edgeCount}`,
		"",
		"Recent graphs:",
	];
	if (graphs.length === 0) {
		out.push("- none yet");
		return out.join("\n");
	}
	for (const graph of graphs.slice(0, 12)) {
		out.push(
			`- ${graph.id} ${graph.rootPath} (${graph.fileCount} files, ${graph.nodeCount} nodes, ${graph.edgeCount} edges)`,
		);
	}
	return out.join("\n");
}

function formatEdge(edge: AxiomCodeGraphEdge, graph: AxiomCodeGraph): string {
	const from = graph.nodes.find((node) => node.id === edge.fromId);
	const to = graph.nodes.find((node) => node.id === edge.toId);
	const label = edge.label ? ` [${edge.label}]` : "";
	return `${nodeText(from)} --${edge.kind}${label}--> ${nodeText(to)}`;
}

function nodeText(node: AxiomCodeGraph["nodes"][number] | undefined): string {
	if (!node) return "(missing)";
	if (node.kind === "file") return node.path ?? node.label;
	if (node.kind === "symbol")
		return `${node.label}${node.path ? ` (${node.path}${node.line ? `:${node.line}` : ""})` : ""}`;
	return node.label;
}
