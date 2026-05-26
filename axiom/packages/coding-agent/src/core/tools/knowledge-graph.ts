import type { AgentTool } from "@axiom/agent-core";
import { Text } from "@axiom/tui";
import { type Static, Type } from "typebox";
import {
	type KnowledgeFactInput,
	type KnowledgeGraphPathResult,
	KnowledgeGraphStore,
} from "../../axiom/KnowledgeGraphStore.ts";
import type {
	AxiomKnowledgeEdge,
	AxiomKnowledgeEdgeStatus,
	AxiomKnowledgeGraphHit,
	AxiomKnowledgeNode,
	AxiomKnowledgeNodeKind,
} from "../../axiom/RuntimeTypes.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const nodeKindSchema = Type.Union([
	Type.Literal("entity"),
	Type.Literal("concept"),
	Type.Literal("fact"),
	Type.Literal("preference"),
	Type.Literal("source"),
	Type.Literal("task"),
	Type.Literal("unknown"),
]);

const edgeStatusSchema = Type.Union([
	Type.Literal("extracted"),
	Type.Literal("inferred"),
	Type.Literal("ambiguous"),
	Type.Literal("user_stated"),
]);

const knowledgeGraphSchema = Type.Object({
	action: Type.Union([
		Type.Literal("remember"),
		Type.Literal("search"),
		Type.Literal("neighbors"),
		Type.Literal("path"),
		Type.Literal("stats"),
	]),
	subject: Type.Optional(Type.String({ description: "Subject node label for remember" })),
	relation: Type.Optional(
		Type.String({ description: "Relationship label for remember, e.g. prefers, works_on, caused_by" }),
	),
	object: Type.Optional(Type.String({ description: "Object node label for remember" })),
	subjectKind: Type.Optional(nodeKindSchema),
	objectKind: Type.Optional(nodeKindSchema),
	status: Type.Optional(edgeStatusSchema),
	confidence: Type.Optional(Type.Number({ description: "Confidence from 0 to 1" })),
	evidence: Type.Optional(Type.String({ description: "Short supporting evidence or original user wording" })),
	source: Type.Optional(Type.String({ description: "Where this fact came from, e.g. user, note filename, URL" })),
	query: Type.Optional(Type.String({ description: "Search query for graph recall" })),
	node: Type.Optional(Type.String({ description: "Node label or id for neighbors" })),
	from: Type.Optional(Type.String({ description: "Start node label or id for path" })),
	to: Type.Optional(Type.String({ description: "Target node label or id for path" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results (default 8)" })),
	maxDepth: Type.Optional(Type.Number({ description: "Maximum path depth (default 4)" })),
});

export type KnowledgeGraphToolInput = Static<typeof knowledgeGraphSchema>;

export interface KnowledgeGraphToolDetails {
	action: KnowledgeGraphToolInput["action"];
	nodeCount: number;
	edgeCount: number;
}

function formatKnowledgeGraphCall(
	args: KnowledgeGraphToolInput | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
): string {
	const action = str(args?.action);
	const invalidArg = invalidArgText(theme);
	return `${theme.fg("toolTitle", theme.bold("knowledge_graph"))} ${
		action === null ? invalidArg : theme.fg("accent", action || "")
	}`;
}

function formatKnowledgeGraphResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: KnowledgeGraphToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 22;
	const display = lines.slice(0, maxLines).map((line) => theme.fg("toolOutput", line));
	if (lines.length > maxLines) {
		display.push(
			theme.fg("muted", `... (${lines.length - maxLines} more lines, ${keyHint("app.tools.expand", "to expand")})`),
		);
	}
	return `\n${display.join("\n")}`;
}

export function createKnowledgeGraphToolDefinition(
	_cwd: string,
): ToolDefinition<typeof knowledgeGraphSchema, KnowledgeGraphToolDetails | undefined> {
	const store = new KnowledgeGraphStore();
	return {
		name: "knowledge_graph",
		label: "knowledge_graph",
		description:
			"Remember and query durable non-code knowledge as a local graph of entities, concepts, preferences, sources, and relationships. Use when the user asks AXIOM to remember something or when prior knowledge could answer a non-code question.",
		promptSnippet: "Remember/query durable non-code knowledge graph",
		promptGuidelines: [
			"Use knowledge_graph action=remember only for durable, useful non-secret facts/preferences/relationships the user explicitly states or asks AXIOM to remember.",
			"Use knowledge_graph action=search/neighbors/path to query prior non-code memory before answering questions that depend on remembered context.",
			"Do not store API keys, passwords, private tokens, or highly sensitive personal data in the knowledge graph.",
		],
		parameters: knowledgeGraphSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: KnowledgeGraphToolInput) {
			const action = params.action;
			const limit = Math.max(1, Math.min(30, Math.floor(params.limit ?? 8)));
			let text: string;
			if (action === "remember") {
				const fact = buildFactInput(params);
				const result = store.addFact(fact);
				const graphStats = store.stats();
				text = [
					`${result.created ? "Stored" : "Updated"} graph edge:`,
					formatEdge(result.edge, result.graph.nodes),
					`Graph now has ${graphStats.nodeCount} node(s), ${graphStats.edgeCount} edge(s).`,
				].join("\n");
			} else if (action === "search") {
				const query = requireParam(params.query, "query");
				text = formatHits(`Search: ${query}`, store.search(query, limit));
			} else if (action === "neighbors") {
				const node = requireParam(params.node ?? params.query, "node");
				const hit = store.neighbors(node, limit);
				text = hit ? formatHits(`Neighbors: ${node}`, [hit]) : `No graph node found for: ${node}`;
			} else if (action === "path") {
				const from = requireParam(params.from, "from");
				const to = requireParam(params.to, "to");
				const path = store.path(from, to, Math.max(1, Math.min(8, Math.floor(params.maxDepth ?? 4))));
				text = path ? formatPath(from, to, path) : `No path found between ${from} and ${to}.`;
			} else {
				text = formatStats(store.stats());
			}

			const stats = store.stats();
			return {
				content: [{ type: "text", text }],
				details: {
					action,
					nodeCount: stats.nodeCount,
					edgeCount: stats.edgeCount,
				},
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatKnowledgeGraphCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatKnowledgeGraphResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createKnowledgeGraphTool(cwd: string): AgentTool<typeof knowledgeGraphSchema> {
	return wrapToolDefinition(createKnowledgeGraphToolDefinition(cwd));
}

function buildFactInput(params: KnowledgeGraphToolInput): KnowledgeFactInput {
	return {
		subject: requireParam(params.subject, "subject"),
		relation: requireParam(params.relation, "relation"),
		object: requireParam(params.object, "object"),
		subjectKind: params.subjectKind as AxiomKnowledgeNodeKind | undefined,
		objectKind: params.objectKind as AxiomKnowledgeNodeKind | undefined,
		status: params.status as AxiomKnowledgeEdgeStatus | undefined,
		confidence: params.confidence,
		evidence: params.evidence,
		source: params.source,
	};
}

function requireParam(value: string | undefined, name: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new Error(`knowledge_graph action requires ${name}.`);
	return trimmed;
}

function formatHits(title: string, hits: AxiomKnowledgeGraphHit[]): string {
	const out: string[] = [title];
	if (hits.length === 0) {
		out.push("No matching graph facts found.");
		return out.join("\n");
	}
	for (const hit of hits) {
		out.push("");
		out.push(
			`Score ${hit.score.toFixed(2)}${hit.matchedKeywords.length ? `, matched: ${hit.matchedKeywords.join(", ")}` : ""}`,
		);
		for (const edge of hit.edges) {
			out.push(`- ${formatEdge(edge, hit.nodes)}`);
			if (edge.evidence) out.push(`  evidence: ${edge.evidence}`);
		}
		const isolated = hit.nodes.filter(
			(node) => !hit.edges.some((edge) => edge.fromId === node.id || edge.toId === node.id),
		);
		for (const node of isolated) {
			out.push(`- ${node.label} (${node.kind})`);
		}
	}
	return out.join("\n");
}

function formatPath(from: string, to: string, result: KnowledgeGraphPathResult): string {
	const out: string[] = [`Path: ${from} -> ${to}`];
	for (const edge of result.edges) {
		out.push(`- ${formatEdge(edge, result.nodes)}`);
	}
	return out.join("\n");
}

function formatStats(stats: {
	nodeCount: number;
	edgeCount: number;
	godNodes: Array<{ node: AxiomKnowledgeNode; degree: number }>;
}): string {
	const out: string[] = [`Knowledge graph: ${stats.nodeCount} node(s), ${stats.edgeCount} edge(s).`, "", "God nodes:"];
	if (stats.godNodes.length === 0) {
		out.push("- none yet");
	} else {
		for (const entry of stats.godNodes) {
			out.push(`- ${entry.node.label} (${entry.node.kind}) degree ${entry.degree}`);
		}
	}
	return out.join("\n");
}

function formatEdge(edge: AxiomKnowledgeEdge, nodes: AxiomKnowledgeNode[]): string {
	const from = nodes.find((node) => node.id === edge.fromId);
	const to = nodes.find((node) => node.id === edge.toId);
	return `${from?.label ?? edge.fromId} --${edge.relation}--> ${to?.label ?? edge.toId} [${edge.status}, ${edge.confidence}]`;
}
