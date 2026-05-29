import type { AgentTool } from "@axiom/agent-core";
import { Text } from "@axiom/tui";
import { type Static, Type } from "typebox";
import { type FlowGraphPathResult, type FlowGraphSliceResult, FlowGraphStore } from "../../axiom/FlowGraphStore.ts";
import type {
	AxiomFlowGraph,
	AxiomFlowGraphEdge,
	AxiomFlowGraphHit,
	AxiomFlowGraphNodeKind,
	AxiomFlowRuntimeTrace,
} from "../../axiom/RuntimeTypes.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const flowGraphSchema = Type.Object({
	action: Type.Union([
		Type.Literal("analyze"),
		Type.Literal("search"),
		Type.Literal("path"),
		Type.Literal("data"),
		Type.Literal("effects"),
		Type.Literal("debug"),
		Type.Literal("trace"),
		Type.Literal("explain"),
		Type.Literal("slice"),
		Type.Literal("stats"),
	]),
	path: Type.Optional(Type.String({ description: "File or directory for action=analyze/effects" })),
	entry: Type.Optional(Type.String({ description: "Optional entrypoint label for action=analyze" })),
	query: Type.Optional(Type.String({ description: "Search query for action=search/data/effects" })),
	graphId: Type.Optional(Type.String({ description: "Specific flow graph id to query" })),
	node: Type.Optional(Type.String({ description: "Node label/path/id for action=explain/slice" })),
	mode: Type.Optional(
		Type.Union([
			Type.Literal("summary", { description: "Compact expandable overview" }),
			Type.Literal("expanded", { description: "Expanded local slice around node/query" }),
		]),
	),
	from: Type.Optional(Type.String({ description: "Start node label/path/id for action=path" })),
	to: Type.Optional(Type.String({ description: "Target node label/path/id for action=path" })),
	command: Type.Optional(Type.String({ description: "Command to run for action=debug/trace" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results/edges (default 8)" })),
	maxDepth: Type.Optional(Type.Number({ description: "Maximum path depth (default 6)" })),
	maxFiles: Type.Optional(Type.Number({ description: "Maximum source files to analyze (default 250, max 1000)" })),
	maxBytesPerFile: Type.Optional(Type.Number({ description: "Maximum bytes read from each source file" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Command timeout for debug/trace actions" })),
});

export type FlowGraphToolInput = Static<typeof flowGraphSchema>;

export interface FlowGraphToolDetails {
	action: FlowGraphToolInput["action"];
	graphId?: string;
	traceId?: string;
	fileCount?: number;
	nodeCount?: number;
	edgeCount?: number;
	exitCode?: number | null;
	timedOut?: boolean;
}

function formatFlowGraphCall(
	args: FlowGraphToolInput | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
): string {
	const action = str(args?.action);
	const invalidArg = invalidArgText(theme);
	let text = `${theme.fg("toolTitle", theme.bold("flow_graph"))} ${
		action === null ? invalidArg : theme.fg("accent", action || "")
	}`;
	if (args?.path) text += theme.fg("toolOutput", ` ${shortenPath(args.path)}`);
	if (args?.query) text += theme.fg("toolOutput", ` "${args.query}"`);
	if (args?.from && args?.to) text += theme.fg("toolOutput", ` ${args.from} -> ${args.to}`);
	if (args?.command) text += theme.fg("toolOutput", ` ${args.command}`);
	return text;
}

function formatFlowGraphResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: FlowGraphToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 30;
	const display = lines.slice(0, maxLines).map((line) => theme.fg("toolOutput", line));
	if (lines.length > maxLines) {
		display.push(
			theme.fg("muted", `... (${lines.length - maxLines} more lines, ${keyHint("app.tools.expand", "to expand")})`),
		);
	}
	return `\n${display.join("\n")}`;
}

export function createFlowGraphToolDefinition(
	cwd: string,
): ToolDefinition<typeof flowGraphSchema, FlowGraphToolDetails | undefined> {
	const store = new FlowGraphStore();
	return {
		name: "flow_graph",
		label: "flow_graph",
		description:
			"Analyze and query static/runtime flow: execution calls, data transformations, branches, loops, async boundaries, errors, effects, events, and command debug traces. Use in rigorous mode when understanding behavior or debugging.",
		promptSnippet: "Analyze execution/data/error/effect/event/runtime flow",
		promptGuidelines: [
			"Use flow_graph analyze in rigorous mode when behavior matters: execution path, data movement, effects, event handlers, or debugging.",
			"Use flow_graph path/from/to to connect entrypoints, callbacks, model calls, tool calls, or failing symbols.",
			"Use flow_graph slice for an expandable flow-chart view: summary first, then pass node=... mode=expanded for more detail.",
			"Use flow_graph data/effects to inspect where values, I/O, network, subprocesses, env vars, and global state are touched.",
			"Use flow_graph debug/trace only when running the command is useful and acceptable; it executes the command with a timeout and maps stack traces back to saved flow graphs.",
			"Use understand_code for per-file summaries and code_graph for repo relationships; use flow_graph for behavior and movement through code.",
		],
		parameters: flowGraphSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: FlowGraphToolInput, signal?: AbortSignal) {
			const action = params.action;
			const limit = Math.max(1, Math.min(60, Math.floor(params.limit ?? 8)));

			if (action === "analyze") {
				const graph = store.analyze({
					path: resolveToCwd(requireParam(params.path, "path"), cwd),
					maxFiles: params.maxFiles,
					maxBytesPerFile: params.maxBytesPerFile,
				});
				let text = formatAnalyze(graph, limit);
				if (params.entry) {
					const hit = store.explain(graph.id, params.entry, limit);
					text += hit
						? `\n\n# Entry\n${formatHits(`Explain: ${params.entry}`, [hit])}`
						: `\n\nNo entry node found: ${params.entry}`;
				}
				return result(action, text, graph);
			}

			if (action === "search") {
				const query = requireParam(params.query, "query");
				const hits = store.search(query, { graphId: params.graphId, limit });
				return result(action, formatHits(`Search: ${query}`, hits), hits[0]?.graph);
			}

			if (action === "data") {
				const query = requireParam(params.query, "query");
				const hits = store.search(query, {
					graphId: params.graphId,
					limit,
					kinds: ["data", "function", "method", "effect", "event"] satisfies AxiomFlowGraphNodeKind[],
				});
				return result(action, formatHits(`Data flow: ${query}`, hits), hits[0]?.graph);
			}

			if (action === "effects") {
				const graph =
					params.path && !params.graphId ? store.analyze({ path: resolveToCwd(params.path, cwd) }) : undefined;
				const graphId = params.graphId ?? graph?.id ?? requireLatestGraphId(store);
				const hit = store.effects(graphId, params.query ?? params.path, limit);
				return result(action, formatHits("Effects / events / errors", [hit]), hit.graph);
			}

			if (action === "path") {
				const graphId = params.graphId ?? requireLatestGraphId(store);
				const from = requireParam(params.from, "from");
				const to = requireParam(params.to, "to");
				const flowPath = store.path(graphId, from, to, Math.max(1, Math.min(12, Math.floor(params.maxDepth ?? 6))));
				const text = flowPath ? formatPath(from, to, flowPath) : `No flow path found from ${from} to ${to}.`;
				return result(action, text, flowPath?.graph ?? store.load(graphId));
			}

			if (action === "explain") {
				const graphId = params.graphId ?? requireLatestGraphId(store);
				const node = requireParam(params.node ?? params.query, "node");
				const hit = store.explain(graphId, node, limit);
				const text = hit ? formatHits(`Explain: ${node}`, [hit]) : `No flow node found for: ${node}`;
				return result(action, text, hit?.graph ?? store.load(graphId));
			}

			if (action === "slice") {
				const graphId = params.graphId ?? requireLatestGraphId(store);
				const slice = store.slice(graphId, params.node ?? params.query, {
					mode: params.mode,
					limit,
					maxDepth: params.maxDepth,
				});
				return result(action, formatSlice(slice), slice.graph);
			}

			if (action === "debug" || action === "trace") {
				const trace = await store.debug({
					command: requireParam(params.command, "command"),
					cwd,
					graphId: params.graphId,
					timeoutMs: params.timeoutMs ?? (action === "trace" ? 15_000 : 30_000),
					signal,
				});
				return {
					content: [{ type: "text" as const, text: formatRuntimeTrace(trace) }],
					details: {
						action,
						traceId: trace.id,
						exitCode: trace.exitCode,
						timedOut: trace.timedOut,
						nodeCount: trace.correlatedNodes.length,
					},
				};
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
			text.setText(formatFlowGraphCall(args, theme));
			return text;
		},
		renderResult(toolResult, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFlowGraphResult(toolResult as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createFlowGraphTool(cwd: string): AgentTool<typeof flowGraphSchema> {
	return wrapToolDefinition(createFlowGraphToolDefinition(cwd));
}

function result(action: FlowGraphToolInput["action"], text: string, graph: AxiomFlowGraph | undefined) {
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
	if (!trimmed) throw new Error(`flow_graph action requires ${name}.`);
	return trimmed;
}

function requireLatestGraphId(store: FlowGraphStore): string {
	const graphId = store.latestGraphId();
	if (!graphId) throw new Error("flow_graph needs a graphId, or run action=analyze first.");
	return graphId;
}

function formatAnalyze(graph: AxiomFlowGraph, limit: number): string {
	const out = [
		`Analyzed flow graph ${graph.id}`,
		`Root: ${graph.rootPath}`,
		`Files: ${graph.fileCount}, nodes: ${graph.nodeCount}, edges: ${graph.edgeCount}`,
		"",
		"Primary execution nodes:",
	];
	for (const node of graph.nodes
		.filter((candidate) => candidate.kind === "function" || candidate.kind === "method" || candidate.kind === "class")
		.slice(0, limit)) {
		out.push(`- ${node.label} (${node.kind}${node.path ? `, ${node.path}${node.line ? `:${node.line}` : ""}` : ""})`);
	}
	out.push("");
	out.push("Effects / events / errors:");
	const effectNodes = graph.nodes
		.filter((candidate) => candidate.kind === "effect" || candidate.kind === "event" || candidate.kind === "error")
		.slice(0, limit);
	if (effectNodes.length === 0) out.push("- none detected");
	for (const node of effectNodes) {
		out.push(`- ${node.label} (${node.kind}${node.path ? `, ${node.path}${node.line ? `:${node.line}` : ""}` : ""})`);
		if (node.summary) out.push(`  ${node.summary}`);
	}
	return out.join("\n");
}

function formatHits(title: string, hits: AxiomFlowGraphHit[]): string {
	const out = [title];
	if (hits.length === 0) {
		out.push("No flow graph hits found. Analyze the code first with action=analyze.");
		return out.join("\n");
	}
	for (const hit of hits) {
		const primary = hit.nodes[0];
		out.push("");
		out.push(
			`Score ${hit.score.toFixed(2)} in ${hit.graph.rootPath}${hit.matchedKeywords.length ? `, matched: ${hit.matchedKeywords.join(", ")}` : ""}`,
		);
		if (primary) {
			out.push(`Primary: ${nodeText(primary)}`);
			if (primary.summary) out.push(`  ${primary.summary}`);
		}
		for (const edge of hit.edges.slice(0, 16)) {
			out.push(`- ${formatEdge(edge, hit.graph)}`);
		}
	}
	return out.join("\n");
}

function formatPath(from: string, to: string, pathResult: FlowGraphPathResult): string {
	const out = [`Flow path: ${from} -> ${to}`, `Graph: ${pathResult.graph.id} (${pathResult.graph.rootPath})`];
	if (pathResult.edges.length === 0) {
		out.push("- same node");
		return out.join("\n");
	}
	for (const edge of pathResult.edges) {
		out.push(`- ${formatEdge(edge, pathResult.graph)}`);
	}
	return out.join("\n");
}

function formatSlice(slice: FlowGraphSliceResult): string {
	const out = [`Flow slice: ${slice.mode}`, `Graph: ${slice.graph.id} (${slice.graph.rootPath})`];
	if (slice.focus) out.push(`Focus: ${nodeText(slice.focus)}`);
	for (const section of slice.sections) {
		out.push("");
		out.push(`# ${section.title}`);
		for (const node of section.nodes.slice(0, 12)) {
			out.push(`- ${nodeText(node)}`);
			if (node.summary) out.push(`  ${node.summary}`);
		}
		for (const edge of section.edges.slice(0, 18)) {
			out.push(`- ${formatEdge(edge, slice.graph)}`);
		}
	}
	if (slice.expansionHints.length > 0) {
		out.push("");
		out.push("# Expand next");
		for (const hint of slice.expansionHints) {
			out.push(`- node="${hint.node.label}" (${hint.reason})`);
		}
	}
	return out.join("\n");
}

function formatRuntimeTrace(trace: AxiomFlowRuntimeTrace): string {
	const out = [
		`Runtime trace ${trace.id}`,
		`Command: ${trace.command}`,
		`Exit: ${trace.exitCode ?? "unknown"}${trace.timedOut ? " (timed out)" : ""}, duration: ${trace.durationMs}ms`,
		"",
		"Stack frames:",
	];
	if (trace.stackFrames.length === 0) out.push("- none detected");
	for (const frame of trace.stackFrames.slice(0, 12)) {
		out.push(`- ${frame.path}${frame.line ? `:${frame.line}` : ""}${frame.column ? `:${frame.column}` : ""}`);
		out.push(`  ${frame.raw}`);
	}
	out.push("");
	out.push("Correlated flow nodes:");
	if (trace.correlatedNodes.length === 0) out.push("- none");
	for (const node of trace.correlatedNodes.slice(0, 12)) {
		out.push(`- ${nodeText(node)}`);
	}
	if (trace.stderrTail.trim()) {
		out.push("");
		out.push("stderr tail:");
		out.push(trace.stderrTail.trim());
	}
	if (trace.stdoutTail.trim()) {
		out.push("");
		out.push("stdout tail:");
		out.push(trace.stdoutTail.trim());
	}
	return out.join("\n");
}

function formatStats(
	stats: { graphCount: number; fileCount: number; nodeCount: number; edgeCount: number; runtimeTraceCount: number },
	graphs: AxiomFlowGraph[],
): string {
	const out = [
		`Flow graphs: ${stats.graphCount}`,
		`Runtime traces: ${stats.runtimeTraceCount}`,
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

function formatEdge(edge: AxiomFlowGraphEdge, graph: AxiomFlowGraph): string {
	const from = graph.nodes.find((node) => node.id === edge.fromId);
	const to = graph.nodes.find((node) => node.id === edge.toId);
	const label = edge.label ? ` [${edge.label}]` : "";
	const line = edge.line ? ` @${edge.line}` : "";
	return `${nodeText(from)} --${edge.kind}${label}${line}--> ${nodeText(to)}`;
}

function nodeText(node: AxiomFlowGraph["nodes"][number] | undefined): string {
	if (!node) return "(missing)";
	const location = node.path ? ` (${node.path}${node.line ? `:${node.line}` : ""})` : "";
	return `${node.label} [${node.kind}]${location}`;
}
