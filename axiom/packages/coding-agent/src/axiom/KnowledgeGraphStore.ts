import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	AxiomKnowledgeEdge,
	AxiomKnowledgeEdgeStatus,
	AxiomKnowledgeGraphHit,
	AxiomKnowledgeGraphSnapshot,
	AxiomKnowledgeNode,
	AxiomKnowledgeNodeKind,
} from "./RuntimeTypes.ts";

const DEFAULT_GRAPH: AxiomKnowledgeGraphSnapshot = {
	version: 1,
	updatedAt: new Date(0).toISOString(),
	nodes: [],
	edges: [],
};

function emptyGraph(): AxiomKnowledgeGraphSnapshot {
	return {
		...DEFAULT_GRAPH,
		updatedAt: new Date().toISOString(),
		nodes: [],
		edges: [],
	};
}

export interface KnowledgeFactInput {
	subject: string;
	relation: string;
	object: string;
	subjectKind?: AxiomKnowledgeNodeKind;
	objectKind?: AxiomKnowledgeNodeKind;
	evidence?: string;
	source?: string;
	status?: AxiomKnowledgeEdgeStatus;
	confidence?: number;
}

export interface KnowledgeGraphPathResult {
	nodes: AxiomKnowledgeNode[];
	edges: AxiomKnowledgeEdge[];
}

/**
 * Local, JSON-backed knowledge graph for durable non-code memory.
 *
 * This is the AXIOM-native Graphify substrate: no server, no Neo4j, no LLM
 * dependency. Tools add explicit subject-relation-object facts, while recall
 * pulls matching subgraphs into future prompts.
 */
export class KnowledgeGraphStore {
	private readonly baseDir: string;
	private readonly graphPath: string;
	private readonly reportPath: string;
	private cached: AxiomKnowledgeGraphSnapshot | null = null;

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? join(homedir(), ".axiom", "agent", "knowledge");
		this.graphPath = join(this.baseDir, "graph.json");
		this.reportPath = join(this.baseDir, "GRAPH_REPORT.md");
	}

	private ensureDir(): boolean {
		try {
			if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });
			return true;
		} catch {
			return false;
		}
	}

	load(): AxiomKnowledgeGraphSnapshot {
		if (this.cached) return this.cached;
		if (!existsSync(this.graphPath)) {
			this.cached = emptyGraph();
			return this.cached;
		}
		try {
			const parsed = JSON.parse(readFileSync(this.graphPath, "utf-8")) as AxiomKnowledgeGraphSnapshot;
			this.cached = {
				version: 1,
				updatedAt: parsed.updatedAt ?? new Date().toISOString(),
				nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
				edges: Array.isArray(parsed.edges) ? parsed.edges : [],
			};
		} catch {
			this.cached = emptyGraph();
		}
		return this.cached;
	}

	addFact(input: KnowledgeFactInput): {
		graph: AxiomKnowledgeGraphSnapshot;
		edge: AxiomKnowledgeEdge;
		created: boolean;
	} {
		const graph = this.load();
		const now = new Date().toISOString();
		const subject = this.upsertNode(graph, {
			label: input.subject,
			kind: input.subjectKind ?? "entity",
			updatedAt: now,
		});
		const object = this.upsertNode(graph, {
			label: input.object,
			kind: input.objectKind ?? "entity",
			updatedAt: now,
		});

		const relation = normalizeRelation(input.relation);
		const edgeId = edgeIdFor(subject.id, relation, object.id);
		let edge = graph.edges.find((candidate) => candidate.id === edgeId);
		let created = false;
		if (!edge) {
			created = true;
			edge = {
				id: edgeId,
				fromId: subject.id,
				toId: object.id,
				relation,
				status: input.status ?? "user_stated",
				confidence: clampConfidence(input.confidence ?? 1),
				evidence: cleanOptional(input.evidence),
				source: cleanOptional(input.source),
				createdAt: now,
				updatedAt: now,
			};
			graph.edges.push(edge);
		} else {
			edge.status = input.status ?? edge.status;
			edge.confidence = Math.max(edge.confidence, clampConfidence(input.confidence ?? edge.confidence));
			edge.evidence = cleanOptional(input.evidence) ?? edge.evidence;
			edge.source = cleanOptional(input.source) ?? edge.source;
			edge.updatedAt = now;
		}

		graph.updatedAt = now;
		this.flush(graph);
		return { graph, edge, created };
	}

	search(query: string, limit: number): AxiomKnowledgeGraphHit[] {
		if (limit <= 0) return [];
		const graph = this.load();
		const queryTokens = new Set(tokenize(query));
		if (queryTokens.size === 0) return [];

		const nodeScore = new Map<string, { score: number; matched: Set<string> }>();
		for (const node of graph.nodes) {
			const nodeTokens = new Set([...tokenize(node.label), ...node.keywords, ...tokenize(node.summary ?? "")]);
			const matched = [...queryTokens].filter((token) => nodeTokens.has(token));
			if (matched.length === 0) continue;
			nodeScore.set(node.id, { score: matched.length * 3, matched: new Set(matched) });
		}

		const hits: AxiomKnowledgeGraphHit[] = [];
		for (const edge of graph.edges) {
			const from = graph.nodes.find((node) => node.id === edge.fromId);
			const to = graph.nodes.find((node) => node.id === edge.toId);
			if (!from || !to) continue;
			const edgeTokens = new Set([
				...tokenize(edge.relation),
				...tokenize(edge.evidence ?? ""),
				...tokenize(edge.source ?? ""),
			]);
			const edgeMatched = [...queryTokens].filter((token) => edgeTokens.has(token));
			const fromScore = nodeScore.get(from.id);
			const toScore = nodeScore.get(to.id);
			const score = (fromScore?.score ?? 0) + (toScore?.score ?? 0) + edgeMatched.length * 2 + edge.confidence;
			if (score <= 0) continue;
			hits.push({
				score,
				matchedKeywords: [...new Set([...(fromScore?.matched ?? []), ...(toScore?.matched ?? []), ...edgeMatched])],
				nodes: [from, to],
				edges: [edge],
			});
		}

		for (const [nodeId, score] of nodeScore) {
			if (hits.some((hit) => hit.nodes.some((node) => node.id === nodeId))) continue;
			const node = graph.nodes.find((candidate) => candidate.id === nodeId);
			if (!node) continue;
			const edges = this.incidentEdges(graph, node.id).slice(0, 4);
			hits.push({
				score: score.score,
				matchedKeywords: [...score.matched],
				nodes: [node, ...this.neighborNodesForEdges(graph, node.id, edges)],
				edges,
			});
		}

		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, limit);
	}

	neighbors(labelOrId: string, limit: number): AxiomKnowledgeGraphHit | undefined {
		const graph = this.load();
		const node = this.findNode(graph, labelOrId);
		if (!node) return undefined;
		const edges = this.incidentEdges(graph, node.id).slice(0, Math.max(1, limit));
		return {
			score: edges.length,
			matchedKeywords: tokenize(labelOrId),
			nodes: [node, ...this.neighborNodesForEdges(graph, node.id, edges)],
			edges,
		};
	}

	path(fromLabelOrId: string, toLabelOrId: string, maxDepth = 4): KnowledgeGraphPathResult | undefined {
		const graph = this.load();
		const start = this.findNode(graph, fromLabelOrId);
		const goal = this.findNode(graph, toLabelOrId);
		if (!start || !goal) return undefined;
		if (start.id === goal.id) return { nodes: [start], edges: [] };

		const queue: Array<{ nodeId: string; edgeIds: string[]; seen: Set<string> }> = [
			{ nodeId: start.id, edgeIds: [], seen: new Set([start.id]) },
		];
		while (queue.length > 0) {
			const current = queue.shift()!;
			if (current.edgeIds.length >= maxDepth) continue;
			for (const edge of this.incidentEdges(graph, current.nodeId)) {
				const nextId = edge.fromId === current.nodeId ? edge.toId : edge.fromId;
				if (current.seen.has(nextId)) continue;
				const nextEdgeIds = [...current.edgeIds, edge.id];
				if (nextId === goal.id) {
					const edges = nextEdgeIds
						.map((id) => graph.edges.find((candidate) => candidate.id === id))
						.filter((candidate): candidate is AxiomKnowledgeEdge => candidate !== undefined);
					const nodeIds = new Set([start.id, goal.id, ...edges.flatMap((e) => [e.fromId, e.toId])]);
					return {
						nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
						edges,
					};
				}
				queue.push({ nodeId: nextId, edgeIds: nextEdgeIds, seen: new Set([...current.seen, nextId]) });
			}
		}
		return undefined;
	}

	stats(): { nodeCount: number; edgeCount: number; godNodes: Array<{ node: AxiomKnowledgeNode; degree: number }> } {
		const graph = this.load();
		const degree = new Map<string, number>();
		for (const edge of graph.edges) {
			degree.set(edge.fromId, (degree.get(edge.fromId) ?? 0) + 1);
			degree.set(edge.toId, (degree.get(edge.toId) ?? 0) + 1);
		}
		const godNodes = graph.nodes
			.map((node) => ({ node, degree: degree.get(node.id) ?? 0 }))
			.filter((entry) => entry.degree > 0)
			.sort((a, b) => b.degree - a.degree || a.node.label.localeCompare(b.node.label))
			.slice(0, 10);
		return { nodeCount: graph.nodes.length, edgeCount: graph.edges.length, godNodes };
	}

	clearCache(): void {
		this.cached = null;
	}

	private upsertNode(
		graph: AxiomKnowledgeGraphSnapshot,
		input: { label: string; kind: AxiomKnowledgeNodeKind; updatedAt: string },
	): AxiomKnowledgeNode {
		const label = cleanRequired(input.label);
		const id = nodeIdFor(label);
		let node = graph.nodes.find((candidate) => candidate.id === id);
		if (!node) {
			node = {
				id,
				label,
				kind: input.kind,
				keywords: tokenize(label),
				createdAt: input.updatedAt,
				updatedAt: input.updatedAt,
			};
			graph.nodes.push(node);
		} else {
			if (node.kind === "unknown" && input.kind !== "unknown") node.kind = input.kind;
			node.updatedAt = input.updatedAt;
			node.keywords = [...new Set([...node.keywords, ...tokenize(label)])];
		}
		return node;
	}

	private findNode(graph: AxiomKnowledgeGraphSnapshot, labelOrId: string): AxiomKnowledgeNode | undefined {
		const normalized = normalizeLabel(labelOrId);
		return graph.nodes.find((node) => node.id === labelOrId || normalizeLabel(node.label) === normalized);
	}

	private incidentEdges(graph: AxiomKnowledgeGraphSnapshot, nodeId: string): AxiomKnowledgeEdge[] {
		return graph.edges
			.filter((edge) => edge.fromId === nodeId || edge.toId === nodeId)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	private neighborNodesForEdges(
		graph: AxiomKnowledgeGraphSnapshot,
		centerId: string,
		edges: AxiomKnowledgeEdge[],
	): AxiomKnowledgeNode[] {
		const ids = new Set(edges.map((edge) => (edge.fromId === centerId ? edge.toId : edge.fromId)));
		return graph.nodes.filter((node) => ids.has(node.id));
	}

	private flush(graph: AxiomKnowledgeGraphSnapshot): void {
		if (!this.ensureDir()) return;
		writeFileSync(this.graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf-8");
		writeFileSync(this.reportPath, renderReport(graph, this.stats()), "utf-8");
		this.cached = graph;
	}
}

export function tokenize(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9_]+/g)
		.map((token) => token.trim())
		.filter((token) => token.length > 1);
}

function nodeIdFor(label: string): string {
	return `n_${hash(normalizeLabel(label), 14)}`;
}

function edgeIdFor(fromId: string, relation: string, toId: string): string {
	return `e_${hash(`${fromId}:${relation}:${toId}`, 16)}`;
}

function hash(text: string, length: number): string {
	return createHash("sha256").update(text).digest("hex").slice(0, length);
}

function normalizeLabel(label: string): string {
	return cleanRequired(label).toLowerCase();
}

function normalizeRelation(relation: string): string {
	return cleanRequired(relation).toLowerCase().replace(/\s+/g, "_").slice(0, 80);
}

function cleanRequired(text: string): string {
	const trimmed = text.replace(/\s+/g, " ").trim();
	if (!trimmed) throw new Error("Knowledge graph fields cannot be empty.");
	return trimmed.slice(0, 240);
}

function cleanOptional(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const trimmed = text.replace(/\s+/g, " ").trim();
	return trimmed ? trimmed.slice(0, 600) : undefined;
}

function clampConfidence(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.max(0, Math.min(1, value));
}

function renderReport(
	graph: AxiomKnowledgeGraphSnapshot,
	stats: { nodeCount: number; edgeCount: number; godNodes: Array<{ node: AxiomKnowledgeNode; degree: number }> },
): string {
	const out: string[] = ["# AXIOM Knowledge Graph Report", ""];
	out.push(`Updated: ${graph.updatedAt}`);
	out.push(`Nodes: ${stats.nodeCount}`);
	out.push(`Edges: ${stats.edgeCount}`);
	out.push("");
	out.push("## God Nodes");
	out.push("");
	if (stats.godNodes.length === 0) {
		out.push("(none yet)");
	} else {
		for (const entry of stats.godNodes) {
			out.push(`- ${entry.node.label} (${entry.node.kind}) - degree ${entry.degree}`);
		}
	}
	out.push("");
	out.push("## Recent Edges");
	out.push("");
	for (const edge of [...graph.edges].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 25)) {
		const from = graph.nodes.find((node) => node.id === edge.fromId);
		const to = graph.nodes.find((node) => node.id === edge.toId);
		out.push(`- ${from?.label ?? edge.fromId} --${edge.relation}--> ${to?.label ?? edge.toId} [${edge.status}]`);
	}
	return `${out.join("\n")}\n`;
}
